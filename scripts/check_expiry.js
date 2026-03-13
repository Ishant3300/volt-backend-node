const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const KiteInstrument = require('../src/models/KiteInstrument');

async function check() {
    try {
        if (!process.env.MONGO_URI) {
            console.error('MONGO_URI not found');
            process.exit(1);
        }
        await mongoose.connect(process.env.MONGO_URI);
        const inst = await KiteInstrument.findOne({ tradingsymbol: 'NIFTY26MARFUT' });
        console.log('Instrument:', inst ? JSON.stringify(inst, null, 2) : 'Not found');
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.connection.close();
    }
}
check();
