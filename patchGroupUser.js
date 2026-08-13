const fs = require('fs');

let content = fs.readFileSync('src/controllers/groupedQuantityController.js', 'utf8');
if (!content.includes('const User = require(')) {
  content = "const User = require('../models/User');\n" + content;
  fs.writeFileSync('src/controllers/groupedQuantityController.js', content, 'utf8');
}
