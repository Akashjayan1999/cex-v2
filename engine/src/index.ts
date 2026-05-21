import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { BALANCES, ORDERBOOKS, ORDERS, type Balance, type OrderStatus } from "./store/exchange-store.js";
import { match } from "./utils/match-engine.js";
export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
  /**
   * TODO(student):
   * 1. Check _message.type.
   * 2. Read _message.payload.
   * 3. Call your order book / balance / order logic.
   * 4. Return the data that should go back to the backend.
   *
   * Required message types:
   * - create_order
   * - get_depth
   * - get_user_balance
   * - get_order
   * - cancel_order
   */

  // just checking the flow, remove this when you start implementing the logic
  if (message.type === "create_order") {
    const {userId, type, side, symbol, price, qty } = message.payload as {
      userId: string;
      type: "market" | "limit";
      side: "buy" | "sell";
      symbol: string;
      price: number | null;
      qty: number;
    };
    const orderId = crypto.randomUUID();
    const fillId = crypto.randomUUID();

    const userBal = BALANCES.get(userId);
    if (!userBal){
      throw new Error("User not found");

    }

    if (side === "buy" && type === "limit") {
      const inr = userBal.USD as Balance;
      const totalCost = (price as number) * qty;
      if (inr.available < totalCost) {
        throw new Error("Insufficient balance");
      }
    }

    if (side === "sell" && type === "limit") {
      const stkBal = userBal[symbol] as Balance;
      if (stkBal.available < qty) {
        throw new Error("Insufficient balance");
      }
    }

    if (side == "sell" && type === "market"){
      const stkBal = userBal[symbol] as Balance;
      if (stkBal.available < qty) {
        throw new Error("Insufficient balance");
      }
    }

    ORDERS.set(orderId, {
      orderId,
      userId,
      side,
      type,
      symbol,
      price,
      qty,
      filledQty: 0,
      status: "open",
      fills: [],
      createdAt: Date.now(),
    });

    const { fills, remainingQty } = match({
    incomingOrderId: orderId,
    userId,
    symbol,
    side,
    type,
    qty,
    price,
   });
   let newStatus:OrderStatus = "open"
   if (fills.length > 0) {
     const filledQtyTotal = fills.reduce((sum, f) => sum + f.qty, 0);
      newStatus =
      filledQtyTotal >= qty ? "filled" : remainingQty > 0 ? "partially_filled" : "open";
    
      for (const fill of fills) {
        const counterOrderId =
          side === "buy" ? fill.sellOrderId : fill.buyOrderId;
          const counterOrder = ORDERS.get(counterOrderId);
          if(counterOrder){
            counterOrder.filledQty += fill.qty;
            counterOrder.fills.push(fill);
            if (counterOrder.filledQty >= counterOrder.qty) {
              counterOrder.status = "filled";
            } else {
              counterOrder.status = "partially_filled";
            }
          }
      }

      const order = ORDERS.get(orderId);
      if (order) {
        order.filledQty += filledQtyTotal;
        order.fills.push(...fills);
        order.status = newStatus;
      }

      
   }


    const order = ORDERS.get(orderId);
    return {
      orderId: order?.orderId,
      status: order?.status,
      filledQty: order?.filledQty ?? 0,
      averagePrice: order && order.filledQty > 0 ? order.fills.reduce((sum, f) => sum + f.price * f.qty, 0) / order.filledQty : null,
      fills,
      note: "Smoke-test response only. Students must replace this with real matching logic.",
    };
  }

  if (message.type === "get_depth") {
    const { symbol } = message.payload  as { symbol: string };
    const book = ORDERBOOKS.get(symbol);

    const bids = book ? [...book.bids.entries()].sort(([a],[b]) => b - a).map(([price,order])=>{
      const {qty, filledQty} = order.reduce((acc, o) => {
        acc.qty += o.qty;
        acc.filledQty += o.filledQty;
        return acc;
      }, {qty: 0, filledQty: 0});
      return {price, qty: qty - filledQty};
    }):[];
    const asks = book ? [...book.asks.entries()].sort(([a],[b]) => a - b).map(([price,order])=>{
      const {qty, filledQty} = order.reduce((acc, o) => {
        acc.qty += o.qty;
        acc.filledQty += o.filledQty;
        return acc;
      }, {qty: 0, filledQty: 0});
      return {price, qty: qty - filledQty};
    }):[];

    return {
      symbol,
      bids,
      asks
    }
  }

  if (message.type === "get_user_balance") {
    const { userId } = message.payload  as { userId: string };
    const balance = BALANCES.get(userId)?.USD || {available: 0, locked: 0};
    return {...balance, currency: "USD"};
  }

  if (message.type === "get_order") {
    const { orderId,userId } = message.payload  as { orderId: string, userId: string };
    const order = ORDERS.get(orderId);
    if (!order || order.userId !== userId) {
      throw new Error("Order not found");
    }
    return order;
  }

  if (message.type === "cancel_order") {
    const { orderId,userId } = message.payload  as { orderId: string, userId: string };
    const order = ORDERS.get(orderId);
    if (!order || order.userId !== userId) {
      throw new Error("Order not found");
    }
    if (order.status === "filled" || order.status === "cancelled") {
      throw new Error("Cannot cancel filled or already cancelled order");
    }

    const orderBook = ORDERBOOKS.get(order.symbol);
    if (!orderBook) {
      throw new Error("Order book not found for symbol");
    }
    if(orderBook){
      const side = order.side === "buy" ? orderBook.bids : orderBook.asks;
      const priceLevel = side.get(order.price as number);
      if (!priceLevel) {
        throw new Error("Price level not found in order book");
      }
      const index = priceLevel.findIndex(o => o.orderId === orderId);
      if (index === -1) {
        throw new Error("Order not found in price level");
      }
     
      priceLevel.splice(index, 1);
    }

    //unlock balance
     const remainingQty = order.qty - order.filledQty;
     const balance = BALANCES.get(userId);
     if (balance && remainingQty > 0){
      if (order.side === "buy" && order.type === "limit") {
        const usd = balance.USD as Balance;
        const unlockAmount = (order.price as number) * remainingQty;
        usd.locked = Math.max(0, usd.locked - unlockAmount);
      }else if (order.side === "sell") {
        const sym = order.symbol;
        const asset = balance[sym] as Balance;
        asset.locked = Math.max(0, asset.locked - remainingQty);

      }
     }

    order.status = "cancelled";

    return {
      orderId,
      status: order.status,
      filledQty: order.filledQty,
      averagePrice: order.filledQty > 0 ? order.fills.reduce((sum, f) => sum + f.price * f.qty, 0) / order.filledQty : null,
      note: "Cancel order response. Students must implement real cancellation logic.",
    };
    

  }

  
  

  throw new Error("TODO(student): implement this engine request type");
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}