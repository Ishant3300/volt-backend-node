// I'll make a script to patch masterController.js for bug 1
const fs = require('fs');
let code = fs.readFileSync('src/controllers/masterController.js', 'utf8');

// I need to add logic in createMaster to check if req.master exists.
// If req.master exists, deduct balance from req.master, just like masterChildController does.
