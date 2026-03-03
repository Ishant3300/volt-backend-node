/**
 * Quick diagnostic script to check bid/ask price status
 * This script checks if the backend is receiving and parsing bid/ask prices correctly
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

console.log('🔍 Bid/Ask Price Diagnostic Tool\n');
console.log('=' .repeat(60));

// Check 1: Environment variables
console.log('\n1️⃣  ENVIRONMENT VARIABLES');
console.log('   MONGO_URI:', process.env.MONGO_URI ? '✅ Set' : '❌ Missing');
console.log('   KITE_API_KEY:', process.env.KITE_API_KEY ? '✅ Set' : '❌ Missing');
console.log('   KITE_API_SECRET:', process.env.KITE_API_SECRET ? '✅ Set' : '❌ Missing');

// Check 2: Files exist
const fs = require('fs');
console.log('\n2️⃣  REQUIRED FILES');
console.log('   instruments.csv:', fs.existsSync(path.join(__dirname, '../instruments.csv')) ? '✅ Exists' : '❌ Missing');
console.log('   .env file:', fs.existsSync(path.join(__dirname, '../.env')) ? '✅ Exists' : '❌ Missing');

// Check 3: Instructions
console.log('\n3️⃣  DIAGNOSTIC STEPS');
console.log('   Step 1: Find the correct instrument token');
console.log('           Run: node test/findGoldToken.js');
console.log('');
console.log('   Step 2: Update testBidAsk.js with the token');
console.log('           Edit: GOLD_INSTRUMENT_TOKEN = <token_from_step_1>');
console.log('');
console.log('   Step 3: Run the bid/ask test');
console.log('           Run: node test/testBidAsk.js');
console.log('');
console.log('   Step 4: Check backend logs');
console.log('           Look for: "📊 Bid:" and "📊 Ask:" messages');
console.log('           Look for: "⚠️  Packet size X bytes" warnings');
console.log('');

// Check 4: Common issues
console.log('4️⃣  COMMON ISSUES & SOLUTIONS');
console.log('');
console.log('   Issue: "No Kite access token found"');
console.log('   Solution: Backend needs to be running and authenticated');
console.log('            The backend auto-login should handle this');
console.log('');
console.log('   Issue: "Packet size 8 bytes" or "Packet size 28 bytes"');
console.log('   Solution: Kite is not sending full mode data');
console.log('            The backend sends mode=full request, but Kite may');
console.log('            take time to switch modes or instrument may not');
console.log('            support full mode (check if it\'s actively traded)');
console.log('');
console.log('   Issue: "Bid/Ask=NULL" in Flutter logs');
console.log('   Solution: Backend is not receiving 184-byte packets');
console.log('            Try a more liquid instrument (NIFTY, BANKNIFTY)');
console.log('');
console.log('   Issue: "Both prices are the same"');
console.log('   Solution: Spread is very small (0.05%)');
console.log('            For GOLD at 70000, spread = 35 rupees');
console.log('            Check if prices differ by ~0.05%');
console.log('');

console.log('=' .repeat(60));
console.log('\n✅ Diagnostic complete. Follow the steps above.\n');
