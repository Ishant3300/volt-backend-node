"""Rename .balance → .equity on User/Master objects in backend JS files."""
import re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = [
    'src/controllers/adminController.js',
    'src/controllers/masterChildController.js',
    'src/controllers/masterUserController.js',
    'src/controllers/masterController.js',
    'src/controllers/tradeController.js',
    'src/services/orderExecutionService.js',
    'src/services/priceQueueService.js',
    'src/services/marginSquareOffService.js',
]

# Match user.balance, master.balance, parentMaster.balance, childMaster.balance, freshUser.balance
pattern = re.compile(r'(?<!\w)(user|master|parentMaster|childMaster|freshUser)\.balance\b')

for rel in files:
    f = os.path.join(ROOT, rel)
    if not os.path.exists(f):
        print(f'SKIP {rel}')
        continue
    content = open(f, 'r', encoding='utf-8').read()
    new_content = pattern.sub(r'\1.equity', content)
    # Fix object creation: "balance: credits," → "equity: credits,"
    new_content = new_content.replace('balance: credits,', 'equity: credits,')
    if content != new_content:
        open(f, 'w', encoding='utf-8').write(new_content)
        count = len(pattern.findall(content))
        print(f'{rel}: {count} .balance → .equity replacements')
    else:
        print(f'{rel}: no changes')
