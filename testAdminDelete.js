const axios = require('axios');
async function test() {
  try {
    const res = await axios.post('http://localhost:3000/api/auth/master/login', {
      username: '219491',
      password: 'password123'
    });
    const token = res.data.data.token;
    console.log("Token:", token);
    
    // Try to delete a random ID
    const deleteRes = await axios.delete('http://localhost:3000/api/admin/script-quantities/6a76e28934c92773f19b059a', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log("Delete res:", deleteRes.data);
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
}
test();
