const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    transactionId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'userModel' // Dynamically reference User or Master
    },
    userModel: {
        type: String,
        required: true,
        enum: ['User', 'Master', 'Admin']
    },
    type: {
        type: String,
        required: true,
        enum: ['CREDIT', 'DEBIT', 'BUY_TRADE', 'SELL_TRADE', 'BUY', 'SELL', 'REFUND', 'FEE', 'DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'CHARGE', 'DIVIDEND', 'INTEREST', 'BONUS', 'ADJUSTMENT']
    },
    status: {
        type: String,
        required: true,
        enum: ['PENDING', 'SUCCESS', 'FAILED', 'ROLLED_BACK'],
        default: 'PENDING'
    },
    amount: {
        type: Number,
        required: true
    },
    currency: {
        type: String,
        default: 'INR'
    },
    referenceId: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: 'referenceModel'
    },
    referenceModel: {
        type: String,
        enum: ['Trade', 'User', 'Master', 'Admin', 'CreditTransaction', 'System']
    },
    balanceBefore: {
        type: Number,
        required: true
    },
    balanceAfter: {
        type: Number,
        required: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, { timestamps: true });

// Create indexes for efficient querying
transactionSchema.index({ userId: 1, type: 1 });
// removed transactionSchema.index({ transactionId: 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ status: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
