jest.mock('../src/models/Trade', () => ({
    aggregate: jest.fn(),
    find: jest.fn()
}));
jest.mock('../src/models/User', () => ({ findById: jest.fn() }));
jest.mock('../src/models/Master', () => ({}));
jest.mock('../src/services/marginService', () => ({ calculateMargin: jest.fn() }));
jest.mock('../src/models/BrokerageSettings', () => ({ find: jest.fn() }));
jest.mock('../src/models/KiteInstrument', () => ({ find: jest.fn() }));

const tradeMetricsService = require('../src/services/tradeMetricsService');
const Trade = require('../src/models/Trade');
const User = require('../src/models/User');
const { calculateMargin } = require('../src/services/marginService');
const BrokerageSettings = require('../src/models/BrokerageSettings');
const KiteInstrument = require('../src/models/KiteInstrument');

const mockLeanQuery = result => ({
    lean: jest.fn().mockResolvedValue(result)
});

const mockSelectLeanQuery = result => ({
    select: jest.fn().mockReturnValue(mockLeanQuery(result))
});

describe('TradeMetricsService.getUserMetrics', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        BrokerageSettings.find.mockReturnValue(mockLeanQuery([]));
        Trade.find.mockReturnValue(mockSelectLeanQuery([]));
        KiteInstrument.find.mockReturnValue(mockLeanQuery([]));
        calculateMargin.mockResolvedValue(0);
    });

    it('should compute metrics correctly for flat positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });
        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '738561', exchange: 'NSE', tradingsymbol: 'RELIANCE' },
                total_buy_qty: 10,
                total_sell_qty: 10,
                total_buy_value: 1000,
                total_sell_value: 1200
            }
        ]);
        Trade.find.mockReturnValue(mockSelectLeanQuery([
            {
                instrument_token: '738561',
                transaction_type: 'BUY',
                executed_quantity: 10,
                executed_price: 100,
                pnl: 0
            },
            {
                instrument_token: '738561',
                transaction_type: 'SELL',
                executed_quantity: 10,
                executed_price: 120,
                pnl: 200
            }
        ]));

        const metrics = await tradeMetricsService.getUserMetrics('user1', new Map());

        expect(metrics.credit).toBe(10000);
        expect(metrics.realised_pnl).toBe(200);
        expect(metrics.position_pnl).toBe(0);
        expect(metrics.m2m_pnl).toBe(200);
        expect(metrics.equity).toBe(10200);
        expect(metrics.margin_used).toBe(0);
        expect(metrics.free_margin).toBe(10200);
        expect(metrics.open_positions_count).toBe(0);
        expect(calculateMargin).not.toHaveBeenCalled();
    });

    it('should compute metrics correctly for open long positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });
        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '738561', exchange: 'NSE', tradingsymbol: 'RELIANCE' },
                total_buy_qty: 10,
                total_sell_qty: 5,
                total_buy_value: 1000,
                total_sell_value: 600
            }
        ]);
        Trade.find.mockReturnValue(mockSelectLeanQuery([
            {
                instrument_token: '738561',
                transaction_type: 'BUY',
                executed_quantity: 10,
                executed_price: 100,
                pnl: 0
            },
            {
                instrument_token: '738561',
                transaction_type: 'SELL',
                executed_quantity: 5,
                executed_price: 120,
                pnl: 100
            }
        ]));
        calculateMargin.mockResolvedValue(50);

        const ltpMap = new Map([['738561', 110]]);
        const metrics = await tradeMetricsService.getUserMetrics('user1', ltpMap);

        expect(metrics.credit).toBe(10000);
        expect(metrics.realised_pnl).toBe(100);
        expect(metrics.position_pnl).toBe(50);
        expect(metrics.m2m_pnl).toBe(150);
        expect(metrics.equity).toBe(10150);
        expect(metrics.margin_used).toBe(50);
        expect(metrics.free_margin).toBe(10100);
        expect(metrics.open_positions_count).toBe(1);
        expect(calculateMargin).toHaveBeenCalledWith('NSE', 5, 110, {
            instrumentToken: '738561',
            tradingsymbol: 'RELIANCE'
        });
    });

    it('should compute metrics correctly for open short positions', async () => {
        User.findById.mockResolvedValue({ _id: 'user1', credits: 10000 });
        Trade.aggregate.mockResolvedValue([
            {
                _id: { instrument_token: '123', exchange: 'NSE', tradingsymbol: 'TCS' },
                total_buy_qty: 0,
                total_sell_qty: 10,
                total_buy_value: 0,
                total_sell_value: 1000
            }
        ]);
        Trade.find.mockReturnValue(mockSelectLeanQuery([
            {
                instrument_token: '123',
                transaction_type: 'SELL',
                executed_quantity: 10,
                executed_price: 100,
                pnl: 0
            }
        ]));
        calculateMargin.mockResolvedValue(200);

        const ltpMap = new Map([['123', 90]]);
        const metrics = await tradeMetricsService.getUserMetrics('user1', ltpMap);

        expect(metrics.realised_pnl).toBe(0);
        expect(metrics.position_pnl).toBe(100);
        expect(metrics.m2m_pnl).toBe(100);
        expect(metrics.equity).toBe(10100);
        expect(metrics.margin_used).toBe(200);
        expect(metrics.free_margin).toBe(9900);
        expect(metrics.open_positions_count).toBe(1);
        expect(calculateMargin).toHaveBeenCalledWith('NSE', 10, 90, {
            instrumentToken: '123',
            tradingsymbol: 'TCS'
        });
    });
});
