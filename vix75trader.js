const WebSocket = require("ws");
const fs = require("fs");

const app_id = process.env.DERIV_APP_ID;
const api_token = process.env.DERIV_API_TOKEN;
let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000;
let requestId = 1;

// Validate environment variables
if (!app_id || !api_token) {
  const error = new Error("Missing required environment variables: DERIV_APP_ID or DERIV_API_TOKEN");
  console.error(error.message);
  fs.appendFileSync("error.log", `${new Date().toISOString()} - ${error.message}\n`);
  process.exit(1);
}

function initWebSocket() {
  ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);

  ws.on("open", () => {
    console.log("WebSocket connected");
    reconnectAttempts = 0;
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
        console.log("Sent ping");
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
    runBot();
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    fs.appendFileSync("error.log", `${new Date().toISOString()} - WebSocket error: ${error.message}\n`);
  });

  ws.on("close", () => {
    console.log("WebSocket closed");
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`Reconnecting attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${reconnectDelay}ms...`);
      setTimeout(initWebSocket, reconnectDelay);
    } else {
      console.error("Max reconnect attempts reached.");
      fs.appendFileSync("error.log", `${new Date().toISOString()} - Max reconnect attempts reached\n`);
    }
  });
}

function sendRequest(request) {
  if (ws.readyState !== WebSocket.OPEN) {
    const error = new Error(`WebSocket not open: readyState ${ws.readyState}`);
    fs.appendFileSync("error.log", `${new Date().toISOString()} - ${error.message}\n`);
    throw error;
  }
  request.req_id = requestId++;
  console.log("Sending request:", JSON.stringify(request));
  ws.send(JSON.stringify(request));
  return request.req_id;
}

function authenticate() {
  return new Promise((resolve, reject) => {
    const reqId = sendRequest({ authorize: api_token });

    const messageHandler = (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch (error) {
        console.error("Auth JSON parse error:", error.message);
        fs.appendFileSync("error.log", `${new Date().toISOString()} - Auth JSON parse error: ${error.message}\n`);
        return;
      }
      if (response.req_id === reqId) {
        if (response.authorize) {
          console.log("Authenticated:", response.authorize.loginid);
          ws.off("message", messageHandler);
          resolve(response.authorize);
        } else if (response.error) {
          console.error("Auth error:", response.error.message);
          fs.appendFileSync("error.log", `${new Date().toISOString()} - Auth error: ${response.error.message}\n`);
          ws.off("message", messageHandler);
          reject(response.error);
        }
      }
    };
    ws.on("message", messageHandler);
  });
}

function getBalance() {
  return new Promise((resolve, reject) => {
    const reqId = sendRequest({ balance: 1 });

    const messageHandler = (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch (error) {
        console.error("Balance JSON parse error:", error.message);
        fs.appendFileSync("error.log", `${new Date().toISOString()} - Balance JSON parse error: ${error.message}\n`);
        return;
      }
      if (response.req_id === reqId) {
        if (response.balance) {
          console.log("Balance:", response.balance.balance);
          fs.appendFileSync("balance.log", `${new Date().toISOString()} - Balance: ${response.balance.balance}\n`);
          ws.off("message", messageHandler);
          resolve(response.balance.balance);
        } else if (response.error) {
          console.error("Balance error:", response.error.message);
          fs.appendFileSync("error.log", `${new Date().toISOString()} - Balance error: ${response.error.message}\n`);
          ws.off("message", messageHandler);
          reject(response.error);
        }
      }
    };
    ws.on("message", messageHandler);
  });
}

function placeTrade(symbol, action, amount = 10) {
  return new Promise((resolve, reject) => {
    const proposalReq = {
      proposal: 1,
      symbol: symbol,
      contract_type: action.toUpperCase(),
      amount: amount,
      basis: "stake",
      currency: "USD",
      duration: 5,
      duration_unit: "t",
    };
    let proposalReqId;
    try {
      proposalReqId = sendRequest(proposalReq);
    } catch (error) {
      console.error("Proposal request error:", error.message);
      fs.appendFileSync("error.log", `${new Date().toISOString()} - Proposal request error: ${error.message}\n`);
      reject(error);
      return;
    }

    const proposalHandler = (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch (error) {
        console.error("Proposal JSON parse error:", error.message);
        fs.appendFileSync("error.log", `${new Date().toISOString()} - Proposal JSON parse error: ${error.message}\n`);
        return;
      }
      if (response.req_id === proposalReqId) {
        if (response.proposal) {
          console.log(`Proposal received: ID ${response.proposal.id}`);
          const buyReq = {
            buy: response.proposal.id,
            price: amount,
          };
          let buyReqId;
          try {
            buyReqId = sendRequest(buyReq);
          } catch (error) {
            console.error("Buy request error:", error.message);
            fs.appendFileSync("error.log", `${new Date().toISOString()} - Buy request error: ${error.message}\n`);
            reject(error);
            ws.off("message", proposalHandler);
            return;
          }

          const buyHandler = (data) => {
            let buyResponse;
            try {
              buyResponse = JSON.parse(data);
            } catch (error) {
              console.error("Buy JSON parse error:", error.message);
              fs.appendFileSync("error.log", `${new Date().toISOString()} - Buy JSON parse error: ${error.message}\n`);
              return;
            }
            if (buyResponse.req_id === buyReqId) {
              if (buyResponse.buy) {
                console.log(`Trade placed: ${action}`, buyResponse.buy);
                fs.appendFileSync("trades.log", `${new Date().toISOString()} - Trade ${action}: ${JSON.stringify(buyResponse.buy)}\n`);
                ws.off("message", buyHandler);
                ws.off("message", proposalHandler);
                resolve(buyResponse.buy);
              } else if (buyResponse.error) {
                console.error("Error buying contract:", buyResponse.error.message);
                fs.appendFileSync("trades.log", `${new Date().toISOString()} - Trade ${action} failed: ${buyResponse.error.message}\n`);
                ws.off("message", buyHandler);
                ws.off("message", proposalHandler);
                reject(buyResponse.error);
              }
            }
          };
          ws.on("message", buyHandler);
        } else if (response.error) {
          console.error("Error getting proposal:", response.error.message);
          fs.appendFileSync("trades.log", `${new Date().toISOString()} - Proposal for ${action} failed: ${response.error.message}\n`);
          ws.off("message", proposalHandler);
          reject(response.error);
        }
      }
    };
    ws.on("message", proposalHandler);
  });
}

function priceActionStrategy(candles) {
  if (candles.length < 2) {
    console.log("Not enough candles for strategy:", candles.length);
    fs.appendFileSync("debug.log", `${new Date().toISOString()} - Not enough candles: ${candles.length}\n`);
    return null;
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  console.log("Checking engulfing:", {
    last: { open: lastCandle.open, close: lastCandle.close },
    prev: { open: prevCandle.open, close: prevCandle.close },
  });
  fs.appendFileSync("debug.log", `${new Date().toISOString()} - Checking engulfing: ${JSON.stringify({
    last: { open: lastCandle.open, close: lastCandle.close },
    prev: { open: prevCandle.open, close: prevCandle.close },
  })}\n`);

  const isStrongCandle = true;
  const isBullishTrend = true;
  const isBearishTrend = true;

  if (
    lastCandle.close > lastCandle.open &&
    prevCandle.open > prevCandle.close &&
    lastCandle.close > prevCandle.open &&
    lastCandle.open < prevCandle.close &&
    isBullishTrend &&
    isStrongCandle
  ) {
    console.log("Bullish engulfing detected");
    fs.appendFileSync("debug.log", `${new Date().toISOString()} - Bullish engulfing detected\n`);
    return "call";
  } else if (
    lastCandle.open > lastCandle.close &&
    prevCandle.close > prevCandle.open &&
    lastCandle.open > prevCandle.close &&
    lastCandle.close < prevCandle.open &&
    isBearishTrend &&
    isStrongCandle
  ) {
    console.log("Bearish engulfing detected");
    fs.appendFileSync("debug.log", `${new Date().toISOString()} - Bearish engulfing detected\n`);
    return "put";
  }
  console.log("No engulfing pattern");
  fs.appendFileSync("debug.log", `${new Date().toISOString()} - No engulfing pattern\n`);
  return null;
}

async function runBot() {
  try {
    await authenticate();
    const balance = await getBalance();
    if (balance < 10) {
      throw new Error("Insufficient balance for trading. Reset demo account to at least $10.");
    }

    const symbol = "R_75";
    console.log("Subscribing to 1-minute candles for:", symbol);

    const reqId = sendRequest({
      ticks_history: symbol,
      subscribe: 1,
      style: "candles",
      granularity: 60,
      adjust_start_time: 1,
      end: "latest",
      count: 5000,
    });

    let candles = [];
    let currentCandle = null;
    let currentOpenTime = null;
    let lastTradeTime = 0;

    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log("Resubscribing to candles...");
        fs.appendFileSync("debug.log", `${new Date().toISOString()} - Resubscribing to candles\n`);
        sendRequest({
          ticks_history: symbol,
          subscribe: 1,
          style: "candles",
          granularity: 60,
          adjust_start_time: 1,
          end: "latest",
          count: 5000,
        });
      }
    }, 300000);

    ws.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch (error) {
        console.error("Message JSON parse error:", error.message);
        fs.appendFileSync("error.log", `${new Date().toISOString()} - Message JSON parse error: ${error.message}\n`);
        return;
      }

      console.log("Received message:", JSON.stringify(response));
      fs.appendFileSync("debug.log", `${new Date().toISOString()} - Received message: ${JSON.stringify(response)}\n`);

      if (response.ping) {
        console.log("Received pong");
        return;
      }

      if (response.balance) {
        fs.appendFileSync("balance.log", `${new Date().toISOString()} - Balance: ${response.balance.balance}\n`);
        console.log("Balance updated:", response.balance.balance);
      }

      if (response.ohlc && response.ohlc.granularity === 60) {
        const ohlc = response.ohlc;
        if (!ohlc.epoch || !ohlc.open || !ohlc.high || !ohlc.low || !ohlc.close || !ohlc.open_time) {
          console.error("Invalid ohlc data:", ohlc);
          fs.appendFileSync("error.log", `${new Date().toISOString()} - Invalid ohlc data: ${JSON.stringify(ohlc)}\n`);
          return;
        }

        console.log("Processing ohlc:", {
          epoch: ohlc.epoch,
          open_time: ohlc.open_time,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
        fs.appendFileSync("debug.log", `${new Date().toISOString()} - Processing ohlc: ${JSON.stringify({
          epoch: ohlc.epoch,
          open_time: ohlc.open_time,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        })}\n`);

        const openTime = parseInt(ohlc.open_time);
        const candle = {
          epoch: parseInt(ohlc.epoch),
          open: parseFloat(ohlc.open),
          high: parseFloat(ohlc.high),
          low: parseFloat(ohlc.low),
          close: parseFloat(ohlc.close),
          open_time: openTime,
        };

        if (currentOpenTime === null || openTime > currentOpenTime) {
          if (currentCandle) {
            candles.push({ ...currentCandle });
            console.log("Finalized candle:", currentCandle);
            fs.appendFileSync("debug.log", `${new Date().toISOString()} - Finalized candle: ${JSON.stringify(currentCandle)}\n`);
            if (candles.length > 100) candles.shift();

            const decision = priceActionStrategy(candles);
            console.log("Strategy decision:", decision);
            fs.appendFileSync("debug.log", `${new Date().toISOString()} - Strategy decision: ${decision}\n`);
            if (decision) {
              const currentTime = currentCandle.epoch;
              if (currentTime - lastTradeTime >= 300) {
                console.log(`Placing ${decision} trade at ${new Date(currentTime * 1000).toLocaleTimeString()}`);
                fs.appendFileSync("debug.log", `${new Date().toISOString()} - Placing ${decision} trade at ${new Date(currentTime * 1000).toLocaleTimeString()}\n`);
                placeTrade(symbol, decision)
                  .then(() => {
                    lastTradeTime = currentTime;
                    getBalance().then((balance) => {
                      console.log("Balance after trade:", balance);
                    });
                  })
                  .catch((error) => {
                    console.error("Trade failed:", error.message);
                    fs.appendFileSync("error.log", `${new Date().toISOString()} - Trade failed: ${error.message}\n`);
                  });
              } else {
                console.log("Trade skipped: Within 5-minute cooldown");
                fs.appendFileSync("debug.log", `${new Date().toISOString()} - Trade skipped: Within 5-minute cooldown\n`);
              }
            }
          }
          currentCandle = { ...candle };
          currentOpenTime = openTime;
          console.log("Started new candle:", currentCandle);
          fs.appendFileSync("debug.log", `${new Date().toISOString()} - Started new candle: ${JSON.stringify(currentCandle)}\n`);
        } else if (openTime === currentOpenTime) {
          currentCandle.close = candle.close;
          currentCandle.high = Math.max(currentCandle.high, candle.high);
          currentCandle.low = Math.min(currentCandle.low, candle.low);
          currentCandle.epoch = candle.epoch;
          console.log("Updated current candle:", currentCandle);
          fs.appendFileSync("debug.log", `${new Date().toISOString()} - Updated current candle: ${JSON.stringify(currentCandle)}\n`);
        }
      } else if (response.error && response.req_id === reqId) {
        console.error("Subscription error:", response.error.message);
        fs.appendFileSync("error.log", `${new Date().toISOString()} - Subscription error: ${response.error.message}\n`);
        ws.close();
      }
    });
  } catch (error) {
    console.error("Bot error:", error.message);
    fs.appendFileSync("error.log", `${new Date().toISOString()} - Bot error: ${error.message}\n`);
  }
}

initWebSocket();