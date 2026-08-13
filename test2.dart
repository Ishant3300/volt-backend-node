import 'dart:convert';
import 'package:http/http.dart' as http;

void main() async {
  print('--- Testing Issue 2: deleteScriptQuantity ownership ---');
  // First, log in as Master 1
  final res1 = await http.post(
    Uri.parse('http://localhost:3000/api/auth/master/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'username': '155455', 'password': 'password123'})
  );
  if (res1.statusCode != 200) {
    print('Failed to login Master 1: \${res1.body}');
    return;
  }
  final m1Body = jsonDecode(res1.body);
  final m1Token = m1Body['data']['token'];
  final m1Id = m1Body['data']['master']['id'];
  print('Master 1 logged in. ID: \$m1Id');

  // Find a script quantity belonging to someone else
  // To do this properly, let's just create one for Master 1, then try to delete it as Master 2.
  final createRes = await http.post(
    Uri.parse('http://localhost:3000/api/admin/script-quantities'),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer \$m1Token'
    },
    body: jsonEncode({
      'exchange_name': 'NSE',
      'script_name': 'RELIANCE',
      'max_qty': 100,
      'brk_qty': 50,
      'lot_size': 1,
      'owner_type': 'Master',
      'owner_id': m1Id
    })
  );
  
  if (createRes.statusCode != 201) {
    print('Failed to create script quantity for Master 1: \${createRes.body}');
    return;
  }
  
  final sqId = jsonDecode(createRes.body)['data']['_id'];
  print('Created Script Quantity ID: \$sqId for Master 1');
  
  // Now login as Master 2 (219491)
  final res2 = await http.post(
    Uri.parse('http://localhost:3000/api/auth/master/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'username': '219491', 'password': 'password123'})
  );
  if (res2.statusCode != 200) {
    print('Failed to login Master 2: \${res2.body}');
    return;
  }
  final m2Body = jsonDecode(res2.body);
  final m2Token = m2Body['data']['token'];
  print('Master 2 logged in.');

  // Now Master 2 tries to delete Master 1's script quantity
  final delRes = await http.delete(
    Uri.parse('http://localhost:3000/api/admin/script-quantities/\$sqId'),
    headers: {
      'Authorization': 'Bearer \$m2Token'
    }
  );
  
  print('Master 2 deleting Master 1 Script Qty Response: \${delRes.statusCode} - \${delRes.body}');
}
