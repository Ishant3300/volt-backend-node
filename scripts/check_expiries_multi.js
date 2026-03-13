const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const KiteInstrument = require('../src/models/KiteInstrument');

async function check() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const insts = await KiteInstrument.find({ tradingsymbol: /^NIFTY/, expiry: { $ne: null } }).limit(20);
        insts.forEach(inst => {
            console.log(`${inst.tradingsymbol.padEnd(20)} -> Expiry: ${inst.expiry ? inst.expiry.toISOString() : 'NULL'}`);
        });
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.connection.close();
    }
}
check();
