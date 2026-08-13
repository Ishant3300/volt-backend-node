const axios = require('axios');
async function test() {
  try {
    const res1 = await axios.post('http://localhost:3000/api/auth/master/login', { username: '155455', password: 'password123' });
    const m1Token = res1.data.data.token;
    const m1Id = res1.data.data.master.id;
    console.log('Master 1 logged in. ID:', m1Id);

    const createRes = await axios.post('http://localhost:3000/api/admin/script-quantities', {
      exchange_name: 'NSE', script_name: 'RELIANCE', max_qty: 100, brk_qty: 50, lot_size: 1, owner_type: 'Master', owner_id: m1Id
    }, { headers: { Authorization: `Bearer ${m1Token}` } });
    const sqId = createRes.data.data._id;
    console.log('Created Script Quantity ID:', sqId, 'for Master 1');
    
    const res2 = await axios.post('http://localhost:3000/api/auth/master/login', { username: '219491', password: 'password123' });
    const m2Token = res2.data.data.token;
    console.log('Master 2 logged in.');

    try {
      const delRes = await axios.delete(`http://localhost:3000/api/admin/script-quantities/${sqId}`, {
        headers: { Authorization: `Bearer ${m2Token}` }
      });
      console.log('Master 2 deleting Master 1 Script Qty Response:', delRes.status, delRes.data);
    } catch(err) {
      console.log('Master 2 delete failed with:', err.response.status, err.response.data);
    }
  } catch(e) { console.log(e.response ? e.response.data : e.message); }
}
test();
