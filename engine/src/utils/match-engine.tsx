import { type OrderType, type Side,type MatchResult, ORDERBOOKS, type Fill, type RestingOrder, BALANCES, type Balance, type OrderBook } from "../store/exchange-store";

function sortedBidPrices(map: Map<number, RestingOrder[]>): number[] {
  return [...map.keys()].sort((a, b) => b - a); // highest first
}

function sortedAskPrices(map: Map<number, RestingOrder[]>): number[] {
  return [...map.keys()].sort((a, b) => a - b); // lowest first
}

function removeDepleted(map: Map<number, RestingOrder[]>, price: number): void {
  const level = map.get(price);
  if (level && level.length === 0) {
    map.delete(price);
  }
}

function match(params: {
  incomingOrderId: string;
  userId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price: number|null; 
}): MatchResult {
const { incomingOrderId, userId, symbol, side, type, qty, price } =
    params;
  const orderBook = ORDERBOOKS.get(symbol);
  if (!orderBook) {
    return {
      fills: [],
      remainingQty: qty,
   };
  };
  const fills: Fill[] = [];
  let remainingQty = qty;

   if (side === "buy") {
    const askPrices = sortedAskPrices(orderBook!.asks);
    for (const askPrice of askPrices) {
      if (remainingQty <= 0) break;
      
      if (type === "limit" && price !== null && askPrice > price) break;
      const level = orderBook!.asks.get(askPrice)!;
      
      for(let i=0; i<level.length && remainingQty > 0; ) {
        const restingOrder = level[i]!;
        const available = restingOrder.qty - restingOrder.filledQty;
        const fillQty = Math.min(remainingQty, available);
        const fillId = crypto.randomUUID();
        fills.push({
          fillId,
          symbol,
          buyOrderId: incomingOrderId,
          sellOrderId: restingOrder.orderId,
          price: askPrice,
          qty: fillQty,
          createdAt: Date.now(),
        });

        restingOrder.filledQty += fillQty;
        remainingQty -= fillQty;

        applyFillToBalances({
          buyerId: userId,
          sellerId: restingOrder.userId,
          symbol,
          price: askPrice,
          qty: fillQty,
        });

        
        if (restingOrder.filledQty === restingOrder.qty) {
          level.splice(i, 1);
        } else {
          i++;
        }

      }

      removeDepleted(orderBook!.asks, askPrice);
    }
    if (type === "limit" && remainingQty > 0 && price !== null) {
        addToBook(orderBook!.bids, price!, {
        orderId: incomingOrderId,
        userId,
        side,
        type,
        symbol,
        price: price!,
        qty,
        filledQty: qty - remainingQty,
        status: "open",
        createdAt: Date.now(),
      });

      // Lock the remaining INR
      lockInr(userId, price! * remainingQty);
    }

   }

   if (side === "sell") {
    const bidPrices = sortedBidPrices(orderBook!.bids);
    for (const bidPrice of bidPrices) {
      if (remainingQty <= 0) break;

      // For LIMIT orders: only match if bid ≥ limit price
      if (type === "limit" && price !== null && bidPrice < price) break;
      const level = orderBook!.bids.get(bidPrice)!;
       for (let i = 0; i < level.length && remainingQty > 0; ) {
         const restingOrder = level[i]!;
         const available = restingOrder.qty - restingOrder.filledQty;
         const fillQty = Math.min(remainingQty, available);
        const fillId = crypto.randomUUID();
        fills.push({
          fillId,
          symbol,
          buyOrderId: restingOrder.orderId,
          sellOrderId: incomingOrderId,
          price: bidPrice,
          qty: fillQty,
          createdAt: Date.now(),
        });
        restingOrder.filledQty += fillQty;
        remainingQty -= fillQty;

         applyFillToBalances({
          buyerId: restingOrder.userId,
          sellerId: userId,
          symbol,
          price: bidPrice,
          qty: fillQty,
        });

        if (restingOrder.filledQty === restingOrder.qty) {
          level.splice(i, 1);
        } else {
          i++;
        }
       }

       removeDepleted(orderBook!.bids, bidPrice);
    }

    if (type === "limit" && remainingQty > 0 && price !== null) {
      addToBook(orderBook!.asks, price!, {
        orderId: incomingOrderId,
        userId,
        side,
        type,
        symbol,
        price: price!,
        qty,
        filledQty: qty - remainingQty,
        status: "open",
        createdAt: Date.now(),
      });

      // Lock the remaining shares
      lockStock(userId, symbol, remainingQty);
    }
   }


  return {
    fills,
    remainingQty,
  };
}

function addToBook(
  side: Map<number, RestingOrder[]>,
  price: number,
  order: RestingOrder
): void {
  if (!side.has(price)) { 
    side.set(price, []);
  }
  const level = side.get(price)!;
  level.push(order);
}


function applyFillToBalances(params: {
  buyerId: string;
  sellerId: string;
  symbol: string;
  price: number;
  qty: number;
}): void {
  const { buyerId, sellerId, symbol, price, qty } = params;
  const cost = price * qty;

  const buyerBal = BALANCES.get(buyerId);
  if (!buyerBal) throw new Error("Buyer not found");
  if (buyerBal){
    const inrBal = buyerBal.USD as Balance;
    if (inrBal.available < cost) {
      throw new Error("Buyer has insufficient balance");
    }
    inrBal.available -= cost;
    inrBal.locked = Math.max(0, inrBal.locked - cost); // unlock any locked amount first

    if(!buyerBal[symbol]){
      buyerBal[symbol] = { available: 0, locked: 0 };
    }
    const stkBal = buyerBal[symbol] as Balance;
    stkBal.available += qty;
   }
  

    const sellerBal = BALANCES.get(sellerId);
    if (!sellerBal) throw new Error("Seller not found");
    if (sellerBal){
        const stkBal = sellerBal[symbol] as Balance;
        stkBal.available -= qty;
        stkBal.locked = Math.max(0, stkBal.locked - qty); // unlock any locked amount first
        const inrBal = sellerBal.USD as Balance;
        inrBal.available += cost;

    }


}


function lockInr(userId: string, amount: number): void {
  const bal = BALANCES.get(userId);
  if (!bal) return;
  const inr = bal.USD as Balance;
  inr.locked += amount;
}

function lockStock(userId: string, symbol: string, qty: number): void {
  const bal = BALANCES.get(userId);
  if (!bal) return;
  if (!bal[symbol]) bal[symbol] = { available: 0, locked: 0 };
  (bal[symbol] as Balance).locked += qty;
}

export { match };