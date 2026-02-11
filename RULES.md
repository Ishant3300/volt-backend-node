# Development Rules & Guidelines

## General Rules

### 1. Naming Conventions
- **Database Collections**: Always use `snake_case` (e.g., `users`, `chat_sessions`, `content_likes`)
- **Model Fields**: Always use `snake_case` (e.g., `user_id`, `is_verified`, `created_at`)
- **Enum Values**: Always use `snake_case` (e.g., `pending`, `not_arrived`, `stoploss_hit`)
- **API Endpoints**: Use kebab-case for URLs (e.g., `/phone-login`, `/verify-otp`)
- **File Names**: Use camelCase for JS files (e.g., `authController.js`, `userRoutes.js`)

### 2. Code Structure
- Controllers handle business logic
- Services handle external integrations (OTP, payments, etc.)
- Middleware handles authentication and validation
- Models define database schemas
- Routes define API endpoints

### 3. Response Format
All API responses must follow this format:
```json
{
  "success": true/false,
  "message": "Description",
  "data": { ... }
}
```

### 4. Error Handling
- Always use try-catch blocks in controllers
- Return appropriate HTTP status codes
- Provide meaningful error messages
- Never expose sensitive information in errors

### 5. Authentication
- Use JWT (JSON Web Token) for authentication
- Token format: `Authorization: Bearer {jwt_token}`
- JWT payload must include: `{ id: user_id, role: 'user' | 'admin' }`
- Validate tokens in middleware using JWT verification
- Store JWT_SECRET in environment variables
- JWT tokens have no expiration (mobile app requirement)

**Authentication Middleware:**
- `authenticateUser`: Only accepts user tokens (required)
- `authenticateAdmin`: Only accepts Admin tokens (required)
- `authenticateAny`: Accepts both user and admin tokens (required)
- `authenticateOptional`: Accepts user or admin tokens, but doesn't fail if no token provided (optional)

**Middleware Usage:**
- Use `authenticateUser` for user-only endpoints 
- Use `authenticateAdmin` for amdin-only endpoints 
- Use `authenticateAny` for shared endpoints that require authentication 
- Use `authenticateOptional` for public endpoints that enhance response with user data if authenticated

### 6. Database
- Use Mongoose for MongoDB operations
- Always define proper indexes
- Use references for relationships
- Transform `_id` to `id` in JSON responses
- Transform `createdAt`/`updatedAt` to `created_at`/`updated_at`
- Use `sparse: true` for unique indexes on optional fields (allows multiple null values)
- Email field is `null` by default for new users/experts (not auto-generated)

### 7. Environment Variables
- Store sensitive data in `.env` file
- Never commit `.env` to version control
- Document all required environment variables

### 8. Testing
- Create HTML test files for each feature
- Organize tests by feature in `/tests` folder
- Test all API endpoints
- Include both success and error scenarios

### 9. Documentation
- Create feature-wise documentation in `/docs` folder
- Document all API endpoints
- Include request/response examples
- **Always include cURL request examples for every endpoint**
- Document authentication requirements
- Keep documentation updated with code changes
- cURL examples must include all headers and request body
- Format cURL examples for readability with line breaks (\)

### 10. Security
- Validate all user inputs
- Sanitize data before database operations
- Use HTTPS in production
- Implement rate limiting
- Hash sensitive data
- Use secure OTP generation

### 11. File Upload (S3)
- Use AWS S3 for file storage
- Validate file types and sizes before upload
- Generate unique file names to prevent conflicts
- Organize files using folder paths (profile-images, content-media, documents, etc.)
- Set appropriate file size limits (10MB default)
- Make uploaded files publicly accessible with secure URLs
- Require authentication for all upload operations

## Model Guidelines

### 1. Schema Definition
- Define all fields with proper types
- Set default values where appropriate
- Add validation rules
- Use enums for fixed value sets
- Add comments for complex fields

### 2. Timestamps
- Always include timestamps: `{ timestamps: true }`
- Transform to snake_case in JSON output

### 3. References
- Use `mongoose.Schema.Types.ObjectId` for references
- Use `refPath` for dynamic references
- Define proper ref models

### 4. Indexes
- Add unique indexes for unique fields
- Add compound indexes for query optimization
- Use sparse indexes for optional unique fields

## API Development Guidelines

### 1. RESTful Principles
- Use proper HTTP methods (GET, POST, PUT, DELETE)
- Use meaningful endpoint names
- Return appropriate status codes
- Use query parameters for filtering

### 2. Validation
- Validate required fields
- Validate data types
- Validate enum values
- Return validation errors clearly

### 3. Pagination
- Implement pagination for list endpoints
- Default page size: 20
- Return total count with results

### 4. Filtering & Sorting
- Support filtering via query parameters
- Support sorting via query parameters
- Document available filters

## Git Guidelines

### 1. Commits
- Write clear commit messages
- Use present tense ("Add feature" not "Added feature")
- Reference issue numbers when applicable

### 2. Branches
- Use feature branches
- Name format: `feature/feature-name`
- Keep branches up to date with main

### 3. Pull Requests
- Provide clear description
- Link related issues
- Request reviews before merging

## Performance Guidelines

### 1. Database Queries
- Use lean() for read-only queries
- Select only required fields
- Use indexes for frequent queries
- Avoid N+1 queries

### 2. Caching
- Cache frequently accessed data
- Use Redis for session storage
- Implement cache invalidation

### 3. API Response
- Minimize response payload
- Use compression
- Implement response caching

## Deployment Guidelines

### 1. Environment Setup
- Use different configs for dev/staging/prod
- Set NODE_ENV appropriately
- Use environment-specific databases

### 2. Monitoring
- Log all errors
- Monitor API performance
- Track user activities
- Set up alerts for critical issues

### 3. Backup
- Regular database backups
- Store backups securely
- Test backup restoration

## LLM & Developer Collaboration

### 1. Code Reviews
- Review all AI-generated code
- Test thoroughly before deployment
- Verify security implications
- Check for edge cases

### 2. Documentation
- Keep documentation in sync with code
- Document AI-assisted changes
- Maintain changelog

### 3. Testing
- Write tests for all features
- Include edge cases
- Test error scenarios
- Verify authentication flows

### 4. Communication
- Clearly specify requirements
- Provide context for changes
- Ask for clarification when needed
- Document decisions and rationale