const tradeMetricsService = require('../src/services/tradeMetricsService');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const TradeMargin = require('../src/models/TradeMargin');

jest.mock('../src/models/Trade');
jest.mock('../src/models/User');
jest.mock('../src/models/TradeMargin');

describe('TradeMetricsService.getUserMetrics', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should compute metrics correctly for flat positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });
        TradeMargin.findOne.mockResolvedValue({ amount_type: 'amount', trade_margin: 0 });

        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '738561', exchange: 'NSE', tradingsymbol: 'RELIANCE' },
                total_buy_qty: 10,
                total_sell_qty: 10,
                total_buy_value: 1000,
                total_sell_value: 1200
            }
        ]);

        const metrics = await tradeMetricsService.getUserMetrics('user1', new Map());

        expect(metrics.credit).toBe(10000);
        expect(metrics.realised_pnl).toBe(200); // 1200 - 1000
        expect(metrics.position_pnl).toBe(0);
        expect(metrics.m2m_pnl).toBe(200);
        expect(metrics.equity).toBe(10200);
        expect(metrics.margin_used).toBe(0);
        expect(metrics.free_margin).toBe(10200);
        expect(metrics.open_positions).toBe(0);
    });

    it('should compute metrics correctly for open long positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });

        // Simulate margin requirement of 10 per share
        TradeMargin.findOne.mockResolvedValue({ amount_type: 'amount', trade_margin: 10 });

        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '738561', exchange: 'NSE', tradingsymbol: 'RELIANCE' },
                total_buy_qty: 10,
                total_sell_qty: 5,
                total_buy_value: 1000, // avg buy = 100
                total_sell_value: 600  // avg sell = 120
            }
        ]);

        const ltpMap = new Map();
        ltpMap.set('738561', 110); // current price

        const metrics = await tradeMetricsService.getUserMetrics('user1', ltpMap);

        // Realised: (600) - (5 * 100) = 100
        // Net Qty: 5
        // Floating: (110 - 100) * 5 = 50
        // Margin used: 5 * 10 = 50

        expect(metrics.credit).toBe(10000);
        expect(metrics.realised_pnl).toBe(100);
        expect(metrics.position_pnl).toBe(50);
        expect(metrics.m2m_pnl).toBe(150);
        expect(metrics.equity).toBe(10150);
        expect(metrics.margin_used).toBe(50);
        expect(metrics.free_margin).toBe(10100);
        expect(metrics.open_positions).toBe(1);
    });

    it('should compute metrics correctly for open short positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });
        TradeMargin.findOne.mockResolvedValue({ amount_type: 'amount', trade_margin: 20 });

        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '123', exchange: 'NSE', tradingsymbol: 'TCS' },
                total_buy_qty: 0,
                total_sell_qty: 10,
                total_buy_value: 0,
                total_sell_value: 1000 // avg sell = 100
            }
        ]);

        const ltpMap = new Map();
        ltpMap.set('123', 90); // price dropped to 90

        const metrics = await tradeMetricsService.getUserMetrics('user1', ltpMap);

        // Realised: 0
        // Net Qty: -10
        // Floating: (100 - 90) * 10 = 100
        // Margin used: 10 * 20 = 200

        expect(metrics.realised_pnl).toBe(0);
        expect(metrics.position_pnl).toBe(100);
        expect(metrics.m2m_pnl).toBe(100);
        expect(metrics.equity).toBe(10100);
        expect(metrics.margin_used).toBe(200);
        expect(metrics.free_margin).toBe(9900);
        expect(metrics.open_positions).toBe(1);
    });
});
