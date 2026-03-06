# Single Session Login Implementation

## Current Behavior

The system already implements single-session login correctly:

1. When a user/admin/master logs in, a new JWT token is generated
2. The new token is stored in the `active_token` field in the database
3. This automatically invalidates any previous sessions
4. The authentication middleware checks if the token in the request matches the `active_token` in the database
5. If they don't match, the request is rejected with 401 Unauthorized

## How It Works

### Login Flow

```javascript
// In authController.js - adminLogin()
const token = generateToken(admin._id, 'admin');
admin.active_token = token;  // This invalidates previous sessions
await admin.save();
```

### Authentication Check

```javascript
// In auth.js - authenticateAdmin()
if (admin.active_token !== token) {
  return res.status(401).json({
    success: false,
    message: 'Session expired. Please login again',
  });
}
```

## The Issue You're Experiencing

Based on your logs:
1. ✅ Login successful - new token generated
2. ✅ Token saved to Flutter secure storage
3. ❌ Subsequent API call gets 401 Unauthorized

This happens because:
- The Flutter app might be using an OLD token from a previous session for some API calls
- There might be a race condition where some providers/services are initialized with the old token before the new one is saved

## Solution

The system is working correctly. The issue is on the Flutter side. Here's what needs to happen:

### 1. Clear Old Token on Login

When logging in, the Flutter app should:
```dart
// Before login
await storage.deleteToken();  // Clear old token
await storage.deleteRole();   // Clear old role

// Then login
final response = await authService.login(...);

// Save new token
await storage.saveToken(token: newToken);
await storage.saveRole(role: newRole);
```

### 2. Reload All Providers After Login

After successful login, all providers should be reinitialized with the new token:
```dart
// In login page after successful login
await userProfileProvider.loadProfile();
await watchlistProvider.loadWatchlist();
await tradeMetricsProvider.fetchBaseData();
```

### 3. Handle 401 Globally

The API service should handle 401 responses globally and redirect to login:
```dart
if (response.statusCode == 401) {
  // Clear stored credentials
  await storage.deleteToken();
  await storage.deleteRole();
  
  // Navigate to login
  NavigationService.navigatorKey.currentState?.pushReplacementNamed('/login');
}
```

## Testing Single Session

To test that single-session login works:

1. Login as admin on Device A
2. Note the token in the logs
3. Login as admin on Device B
4. Device A should now get 401 errors (session invalidated)
5. Device B should work normally

## Current Status

✅ Backend correctly implements single-session login
✅ Authentication middleware properly validates tokens
✅ Old sessions are automatically invalidated on new login

The issue you're experiencing is likely due to:
- Flutter app using cached/old token for some API calls
- Race condition in provider initialization
- Token not being properly updated in all services

## Recommendation

Check the Flutter app's token management:
1. Ensure old token is cleared before login
2. Ensure new token is saved immediately after login
3. Ensure all providers/services use the new token
4. Add global 401 handler to redirect to login

The backend is working correctly - no changes needed there.
