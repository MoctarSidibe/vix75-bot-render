const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const API_TOKEN = process.env.DERIV_API_TOKEN;
const APP_ID = process.env.DERIV_APP_ID;
const WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=' + APP_ID;

if (!API_TOKEN || !APP_ID) {
  console.error('Missing required environment variables: DERIV_API_TOKEN or DERIV_APP_ID');
  process.exit(1);
}

let ws;
let candles = [];
let currentCandle = null;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Connected to Deriv WebSocket');
    authenticate();
    subscribeToOHLC();
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    handleWebSocketMessage(msg);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket closed. Reconnecting...');
    setTimeout(connectWebSocket, 1000);
  });
}

function authenticate() {
  ws.send(JSON.stringify({
    authorize: API_TOKEN
  }));
}

function subscribeToOHLC() {
  ws.send(JSON.stringify({
    ticks_history: 'V_75',
    adjust_start_time: 1,
    count: 100,
    end: 'latest',
    start: 1,
    style: 'candles',
    granularity: 60
  }));

  ws.send(JSON.stringify({
    ohlc: 1,
    symbol: 'V_75',
    granularity: 60,
    subscribe: 1
  }));
}

function handleWebSocketMessage(msg) {
  if (msg.authorize) {
    console.log('Authenticated successfully');
  } else if (msg.candles) {
    msg.candles.forEach(candle => {
      candles.push({
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        open_time: candle.epoch
      });
    });
    console.log('Loaded', candles.length, 'historical candles');
  } else if (msg.ohlc) {
    const ohlc = msg.ohlc;
    const newOpenTime = parseInt(ohlc.open_time);

    if (!currentCandle) {
      currentCandle = {
        open: parseFloat(ohlc.open),
        high: parseFloat(ohlc.high),
        low: parseFloat(ohlc.low),
        close: parseFloat(ohlc.close),
        open_time: newOpenTime
      };
      console.log('Started new candle:', currentCandle);
    } else if (newOpenTime !== currentCandle.open_time) {
      candles.push(currentCandle);
      console.log('Finalized candle:', currentCandle);
      currentCandle = {
        open: parseFloat(ohlc.open),
        high: parseFloat(ohlc.high),
        low: parseFloat(ohlc.low),
        close: parseFloat(ohlc.close),
        open_time: newOpenTime
      };
      console.log('Started new candle:', currentCandle);
      checkStrategy();
    } else {
      currentCandle.high = Math.max(currentCandle.high, parseFloat(ohlc.high));
      currentCandle.low = Math.min(currentCandle.low, parseFloat(ohlc.low));
      currentCandle.close = parseFloat(ohlc.close);
      console.log('Updated current candle:', currentCandle);
    }
  }
}

function priceActionStrategy() {
  if (candles.length < 2) {
    console.log('Not enough candles to check engulfing. Current count:', candles.length);
    return null;
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  console.log('Checking engulfing with candles:', {
    prev: { open: prevCandle.open, close: prevCandle.close },
    last: { open: lastCandle.open, close: lastCandle.close }
  });

  const isPrevBearish = prevCandle.open > prevCandle.close;
  const isLastBullish = lastCandle.close > lastCandle.open;
  const isBullishEngulfing = isPrevBearish && isLastBullish && lastCandle.close > prevCandle.open && lastCandle.open < prevCandle.close;

  const isPrevBullish = prevCandle.close > prevCandle.open;
  const isLastBearish = lastCandle.open > lastCandle.close;
  const isBearishEngulfing = isPrevBullish && isLastBearish && lastCandle.open > prevCandle.close && lastCandle.close < prevCandle.open;

  console.log('Engulfing conditions:', {
    isPrevBearish,
    isLastBullish,
    isBullishEngulfing,
    isPrevBullish,
    isLastBearish,
    isBearishEngulfing
  });

  if (isBullishEngulfing) {
    console.log('Bullish engulfing detected');
    return 'call';
  } else if (isBearishEngulfing) {
    console.log('Bearish engulfing detected');
    return 'put';
  } else {
    console.log('No engulfing pattern detected');
    return null;
  }
}

function placeTrade(decision) {
  const tradeParams = {
    buy: 1,
    price: 1,
    parameters: {
      contract_type: decision.toUpperCase(),
      symbol: 'V_75',
      duration: 5,
      duration_unit: 'm',
      stake: 1,
      basis: 'stake'
    },
    passthrough: { id: uuidv4() }
  };

  console.log('Placing trade:', tradeParams);
  ws.send(JSON.stringify(tradeParams));
}

function checkStrategy() {
  console.log('Checking strategy with', candles.length, 'candles');
  const decision = priceActionStrategy();
  if (decision) {
    placeTrade(decision);
  }
}

connectWebSocket();