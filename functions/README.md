Setup & deploy (Firebase Functions)

1) Install dependencies and the Firebase CLI:
   npm install
   npm install -g firebase-tools

2) Configure environment key for AbstractAPI (or set env var ABSTRACTAPI_KEY):
   firebase functions:config:set abstractapi.key="YOUR_ABSTRACTAPI_KEY"

3) Deploy functions:
   firebase deploy --only functions

Endpoint after deploy:
   https://<region>-<project>.cloudfunctions.net/register

Notes:
- The function calls AbstractAPI (email validation) and only creates a Firebase Auth user when the email is considered deliverable.
- The created user is marked emailVerified=true so no verification email is needed.
- For local testing you can set process.env.ABSTRACTAPI_KEY and run the functions emulator.
- Ensure your Firebase project has the Admin SDK permissions (deploy to your project).
