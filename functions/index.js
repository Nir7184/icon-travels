const functions = require('firebase-functions');
const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// Initialize admin SDK (Firebase Functions will provide credentials in production)
try { admin.initializeApp(); } catch (err) { console.warn('Admin init warning', err); }
const db = admin.firestore();

const app = express();
app.use(express.json());

// CORS - required for browser fetch() from your website
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  next();
});

// Use environment variable ABSTRACTAPI_KEY or runtime config:
//   firebase functions:config:set abstractapi.key="YOUR_KEY"
const ABSTRACT_API_KEY =
  process.env.ABSTRACTAPI_KEY ||
  (functions.config && functions.config().abstractapi && functions.config().abstractapi.key) ||
  '';

// ===========================
// Email configuration (FREE)
// ===========================
// IMPORTANT: This avoids Secret Manager (secretmanager.googleapis.com) so it does NOT require Blaze.
// Recommended setup (Gmail App Password):
//   firebase functions:config:set mail.user="YOUR_GMAIL" mail.pass="YOUR_GMAIL_APP_PASSWORD"
//
// Alternative: environment variables (local emulators / other hosts):
//   MAIL_USER, MAIL_PASS
const MAIL_USER =
  process.env.MAIL_USER ||
  (functions.config && functions.config().mail && functions.config().mail.user) ||
  '';
const MAIL_PASS =
  process.env.MAIL_PASS ||
  (functions.config && functions.config().mail && functions.config().mail.pass) ||
  '';

function getTransporter() {
  if (!MAIL_USER || !MAIL_PASS) {
    throw new Error(
      'Email not configured. Set mail.user/mail.pass via `firebase functions:config:set` (recommended) or MAIL_USER/MAIL_PASS env vars.'
    );
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_USER, pass: MAIL_PASS }
  });
}

// Admin notification inbox (where you want to RECEIVE inquiries + booking notifications)
const SUPPORT_EMAIL = 'ict22nirbhay@gmail.com';
// Sender identity (emails are sent using nodemailer transporter auth; this "from" is display/from address)
const COMPANY_EMAIL = 'ict22nirbhay@gmail.com';

// Basic email format regex (server-side repeat of client validation)
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper to extract the authenticated user's email from the
// Authorization header (`Bearer <idToken>`). Throws if the token is
// missing/invalid or contains no email.  Used by the OTP endpoints so
// that the client cannot spoof a different recipient.
async function getEmailFromRequest(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const parts = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!parts) {
    throw new Error('Missing Authorization header');
  }
  const idToken = parts[1];
  const decoded = await admin.auth().verifyIdToken(idToken);
  if (!decoded || !decoded.email) {
    throw new Error('Invalid auth token');
  }
  return String(decoded.email).trim().toLowerCase();
}

// ============================
// Firestore Triggers (AUTO EMAIL)
// ============================

function safeToString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function formatPlacesForText(places) {
  if (!Array.isArray(places) || places.length === 0) return 'Not specified';
  return places.join(', ');
}

exports.onInquiryCreated = functions.firestore
  .document('inquiries/{inquiryId}')
  .onCreate(async (snap, context) => {
    const transporter = getTransporter();
    const data = snap.data() || {};
    const userEmail = data.email || data.userEmail || '';
    const userName = data.name || 'Customer';
    const phone = data.phone || '';
    const message = data.message || '';
    const createdAt = data.createdAt || '';

    const subject = `New Inquiry - ${userName}`;
    const text = [
      'New inquiry received from Icon Travels website.',
      '',
      `Inquiry ID: ${context.params.inquiryId}`,
      `Created At: ${safeToString(createdAt)}`,
      '',
      'Customer Details:',
      `- Name: ${safeToString(userName)}`,
      `- Email: ${safeToString(userEmail)}`,
      `- Phone: ${safeToString(phone)}`,
      '',
      'Message:',
      safeToString(message),
      '',
      'Reply directly to the customer email to answer their question.'
    ].join('\n');

    await transporter.sendMail({
      from: COMPANY_EMAIL,
      to: SUPPORT_EMAIL,
      subject,
      text
    });

    return null;
  });

exports.onBookingCreated = functions.firestore
  .document('bookings/{bookingId}')
  .onCreate(async (snap, context) => {
    const transporter = getTransporter();
    const data = snap.data() || {};

    const userEmail = data.email || '';
    const userName = data.name || 'Customer';
    const packageTitle = data.packageTitle || 'Travel Package';
    const location = data.location || '';
    const travelDate = data.travelDate || data.date || '';
    const bookingDate = data.bookingDate || data.createdAt || '';
    const travelers = data.travelers || 1;
    const amount = data.amount || data.total || 0;
    const phone = data.phone || '';
    const places = Array.isArray(data.places) ? data.places : [];

    // 1) Send booking confirmation to user (if email exists)
    if (userEmail && emailPattern.test(userEmail)) {
      const userSubject = `✅ Booking Confirmed! ${packageTitle}`;
      const userText = [
        `Hi ${safeToString(userName)},`,
        '',
        'Thank you for booking with Icon Travels!',
        '',
        'Booking Details:',
        `- Booking ID: ${context.params.bookingId}`,
        `- Package: ${safeToString(packageTitle)}`,
        `- Location: ${safeToString(location)}`,
        `- Travel Date: ${safeToString(travelDate)}`,
        `- Booking Date: ${safeToString(bookingDate)}`,
        `- Travelers: ${safeToString(travelers)}`,
        `- Total Amount: ₹${safeToString(amount)}`,
        `- Places Covered: ${formatPlacesForText(places)}`,
        '',
        'From,',
        'Icon Travels Team'
      ].join('\n');

      await transporter.sendMail({
        from: COMPANY_EMAIL,
        to: userEmail,
        subject: userSubject,
        text: userText
      });
    }

    // 2) Send admin notification to SUPPORT_EMAIL
    const adminSubject = `New Booking - ${packageTitle} (${safeToString(userName)})`;
    const adminText = [
      'New booking received from Icon Travels website.',
      '',
      `Booking ID: ${context.params.bookingId}`,
      `Booking Date: ${safeToString(bookingDate)}`,
      `Travel Date: ${safeToString(travelDate)}`,
      '',
      'Package Details:',
      `- Package: ${safeToString(packageTitle)}`,
      `- Location: ${safeToString(location)}`,
      `- Travelers: ${safeToString(travelers)}`,
      `- Total Amount: ₹${safeToString(amount)}`,
      `- Places Covered: ${formatPlacesForText(places)}`,
      '',
      'Customer Details:',
      `- Name: ${safeToString(userName)}`,
      `- Email: ${safeToString(userEmail)}`,
      `- Phone: ${safeToString(phone)}`
    ].join('\n');

    await transporter.sendMail({
      from: COMPANY_EMAIL,
      to: SUPPORT_EMAIL,
      subject: adminSubject,
      text: adminText
    });

    return null;
  });

// ============================
// HTTPS Endpoints
// ============================

app.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, message: 'Email and password are required.' });
    if (!emailPattern.test(email)) return res.status(400).json({ ok: false, message: 'Invalid email format.' });
    if (password.length < 6) return res.status(400).json({ ok: false, message: 'Password must be at least 6 characters.' });

    if (!ABSTRACT_API_KEY) return res.status(500).json({ ok: false, message: 'Email validation provider not configured on the server.' });

    // Call AbstractAPI email validation
    const aurl = `https://emailvalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(ABSTRACT_API_KEY)}&email=${encodeURIComponent(email)}`;
    const r = await fetch(aurl);
    if (!r.ok) return res.status(502).json({ ok: false, message: 'Email validation service error.' });
    const jr = await r.json();

    // Heuristics to determine deliverability
    const deliverability = (jr && jr.deliverability) ? jr.deliverability.toUpperCase() : '';
    const isSmtpValid = jr && jr.is_smtp_valid && (jr.is_smtp_valid.value === true || String(jr.is_smtp_valid.value).toLowerCase() === 'true');
    const isDisposable = jr && jr.is_disposable && (jr.is_disposable.value === true || String(jr.is_disposable.value).toLowerCase() === 'true');
    const isRole = jr && jr.is_role && (jr.is_role.value === true || String(jr.is_role.value).toLowerCase() === 'true');

    if (isDisposable || isRole) return res.status(400).json({ ok: false, message: 'Disposable or role-based email addresses are not allowed.' });
    if (!(deliverability === 'DELIVERABLE' || isSmtpValid)) {
      return res.status(400).json({ ok: false, message: 'Email address does not appear deliverable.' });
    }

    // Check if user already exists
    try {
      const existing = await admin.auth().getUserByEmail(email);
      if (existing) return res.status(409).json({ ok: false, message: 'Email already registered.' });
    } catch (e) {
      // If not found, getUserByEmail throws; proceed
      if (e.code && e.code !== 'auth/user-not-found') {
        console.warn('getUserByEmail error', e);
      }
    }

    // Create the user via Admin SDK and mark emailVerified=true so no verification email required
    const user = await admin.auth().createUser({ email, password, emailVerified: true });

    // Create basic Firestore profile
    try {
      await db.collection('users').doc(user.uid).set({ email, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.warn('Could not write user record:', err);
    }

    return res.json({ ok: true, uid: user.uid });
  } catch (err) {
    console.error('Register endpoint error', err);
    return res.status(500).json({ ok: false, message: 'Server error: ' + (err.message || 'unknown') });
  }
});

// Booking confirmation endpoint - sends email when booking is created (HTML email)
app.post('/send-booking-confirmation', async (req, res) => {
  try {
    const transporter = getTransporter();
    const {
      userEmail,
      userName,
      packageTitle,
      location,
      places,
      travelers,
      bookingDate,
      travelDate,
      days,
      amount,
      phone,
      bookingId,
      whatToBring
    } = req.body || {};

    if (!userEmail || !userName || !packageTitle) {
      return res.status(400).json({ ok: false, message: 'Missing required booking details' });
    }

    // Generate places list HTML
    let placesHTML = '';
    if (places && Array.isArray(places)) {
      placesHTML = places.map(place => `<li style="margin: 5px 0; color: #333;">${place}</li>`).join('');
    }

    // Generate what to bring list
    let whatToBringHTML = '';
    if (whatToBring && Array.isArray(whatToBring)) {
      whatToBringHTML = whatToBring.map(item => `<li style="margin: 5px 0; color: #333;">${item}</li>`).join('');
    } else {
      whatToBringHTML = `
        <li style="margin: 5px 0; color: #333;">Comfortable walking shoes</li>
        <li style="margin: 5px 0; color: #333;">Sunscreen and cap</li>
        <li style="margin: 5px 0; color: #333;">Water bottle and snacks</li>
        <li style="margin: 5px 0; color: #333;">Light jacket or sweater</li>
        <li style="margin: 5px 0; color: #333;">Valid ID proof</li>
        <li style="margin: 5px 0; color: #333;">Phone and charger</li>
        <li style="margin: 5px 0; color: #333;">Personal medications</li>
      `;
    }

    // Create professional HTML email template
    const emailHTML = `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
            .header { background: linear-gradient(135deg, #1e3a5f, #ff6b35); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; }
            .content { padding: 30px; }
            .section { margin: 25px 0; }
            .section h2 { color: #1e3a5f; font-size: 18px; border-bottom: 2px solid #ff6b35; padding-bottom: 10px; }
            .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px; }
            .detail-item { background: #f8f9fa; padding: 12px; border-left: 4px solid #ff6b35; border-radius: 4px; }
            .detail-label { font-weight: bold; color: #1e3a5f; font-size: 12px; text-transform: uppercase; }
            .detail-value { color: #333; font-size: 16px; margin-top: 5px; }
            .places-list { background: #e8f0f7; padding: 15px; border-radius: 8px; margin-top: 10px; }
            .footer { background: #1e3a5f; color: white; padding: 20px; text-align: center; font-size: 12px; }
            .important { background: #fffbea; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px; margin: 15px 0; }
            .important h3 { margin: 0 0 10px 0; color: #92400e; }
            .btn { display: inline-block; background: #ff6b35; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin: 10px 0; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ Booking Confirmation</h1>
              <p>Your travel adventure awaits!</p>
            </div>
            
            <div class="content">
              <p>Hi ${userName},</p>
              <p>Thank you for booking with <strong>Icon Travels</strong>! Your adventure is confirmed. Here are your booking details:</p>
              
              <div class="section">
                <h2>📋 Booking Details</h2>
                <div class="details-grid">
                  <div class="detail-item">
                    <div class="detail-label">Booking ID</div>
                    <div class="detail-value">#${bookingId ? String(bookingId).substring(0, 10).toUpperCase() : 'PENDING'}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Booking Date</div>
                    <div class="detail-value">${bookingDate ? new Date(bookingDate).toLocaleDateString('en-IN') : ''}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Travel Date</div>
                    <div class="detail-value">${travelDate ? new Date(travelDate).toLocaleDateString('en-IN') : ''}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Duration</div>
                    <div class="detail-value">${days || 'As per package'} Days</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Number of Travelers</div>
                    <div class="detail-value">${travelers || 1} Person(s)</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Total Amount</div>
                    <div class="detail-value" style="color: #ff6b35; font-weight: bold;">₹${amount ? Number(amount).toLocaleString('en-IN') : '0'}</div>
                  </div>
                </div>
              </div>

              <div class="section">
                <h2>🎒 Package Information</h2>
                <div class="detail-item" style="border-left: 4px solid #10b981;">
                  <div class="detail-label">Package Name</div>
                  <div class="detail-value">${packageTitle}</div>
                </div>
                <div class="detail-item" style="border-left: 4px solid #10b981; margin-top: 10px;">
                  <div class="detail-label">Destination</div>
                  <div class="detail-value">${location || ''}</div>
                </div>
              </div>

              <div class="section">
                <h2>🗺️ Places You'll Visit</h2>
                <div class="places-list">
                  <ul style="margin: 0; padding-left: 20px;">
                    ${placesHTML || '<li>Scenic locations and local attractions</li>'}
                  </ul>
                </div>
              </div>

              <div class="section">
                <h2>🧳 What to Bring</h2>
                <div style="background: #e8f0f7; padding: 15px; border-radius: 8px;">
                  <ul style="margin: 0; padding-left: 20px;">
                    ${whatToBringHTML}
                  </ul>
                </div>
              </div>

              <div class="important">
                <h3>📞 Your Contact Information</h3>
                <p><strong>Name:</strong> ${userName}</p>
                <p><strong>Email:</strong> ${userEmail}</p>
                <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
              </div>

              <div class="important">
                <h3>❓ Have Questions?</h3>
                <p>Our support team is here to help! You can reach us at:</p>
                <p><strong>📧 Email:</strong> ${SUPPORT_EMAIL}</p>
                <p><strong>📱 Phone:</strong> +91-XXX-XXX-XXXX</p>
                <p style="color: #92400e; font-size: 14px; margin-top: 10px;">We typically respond within 24 hours during business hours.</p>
              </div>

              <div class="section" style="background: #d1fae5; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                <h3 style="margin-top: 0; color: #065f46;">✅ What Happens Next?</h3>
                <ol style="color: #065f46;">
                  <li>Our team will review your booking</li>
                  <li>We'll send you a confirmation email (usually within 2-4 hours)</li>
                  <li>Payment instructions will be provided</li>
                  <li>Detailed itinerary will be sent before your travel date</li>
                  <li>A final reminder email will be sent 24 hours before departure</li>
                </ol>
              </div>

              <p style="margin-top: 30px; color: #666; font-size: 14px;">
                Thank you for choosing <strong>Icon Travels</strong>. We're excited to help you create unforgettable memories!
              </p>
            </div>

            <div class="footer">
              <p style="margin: 0;">Icon Travels - Your Perfect Travel Destination</p>
              <p style="margin: 5px 0 0 0; font-size: 11px; opacity: 0.8;">${new Date().getFullYear()} © All rights reserved. | support@icontravels.com</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Send email to user
    await transporter.sendMail({
      from: COMPANY_EMAIL,
      to: userEmail,
      subject: `✅ Booking Confirmed! ${packageTitle}`,
      html: emailHTML
    });

    // Send notification to admin
    await transporter.sendMail({
      from: COMPANY_EMAIL,
      to: SUPPORT_EMAIL,
      subject: `New Booking: ${packageTitle} by ${userName}`,
      html: `
        <h2>New Booking Received</h2>
        <p><strong>Name:</strong> ${userName}</p>
        <p><strong>Email:</strong> ${userEmail}</p>
        <p><strong>Phone:</strong> ${phone || ''}</p>
        <p><strong>Package:</strong> ${packageTitle}</p>
        <p><strong>Travelers:</strong> ${travelers || 1}</p>
        <p><strong>Travel Date:</strong> ${travelDate || ''}</p>
        <p><strong>Amount:</strong> ₹${amount || 0}</p>
        <p><strong>Booking ID:</strong> ${bookingId || ''}</p>
        <p>Please follow up with the customer to complete the booking process.</p>
      `
    });

    return res.json({ ok: true, message: 'Booking confirmation email sent successfully' });
  } catch (err) {
    console.error('Booking email error:', err);
    return res.status(500).json({ ok: false, message: 'Error sending confirmation email: ' + err.message });
  }
});

// ===========================
// OTP Endpoints (Email OTP via Gmail SMTP)
// ===========================
// Uses Firestore collection: otps (docId = lowercase email)
// OTP expires in 5 minutes, max 3 verify attempts

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 3;

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.post('/send-otp', async (req, res) => {
  try {
    // must be authenticated; derive email from ID token, ignore any body fields
    let normalizedEmail;
    try {
      normalizedEmail = await getEmailFromRequest(req);
    } catch (e) {
      return res.status(401).json({ ok: false, message: 'Unauthorized (invalid or missing auth token)' });
    }
    if (!emailPattern.test(normalizedEmail)) {
      return res.status(400).json({ ok: false, message: 'Invalid email format.' });
    }

    const transporter = getTransporter();
    const otp = generateOTP();
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    console.log('Sending OTP', otp, 'to', normalizedEmail, '(auth-based)');

    const otpRef = db.collection('otps').doc(normalizedEmail);
    await otpRef.set({
      otp,
      expiresAt,
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const fromAddr = MAIL_USER || COMPANY_EMAIL;
    await transporter.sendMail({
      from: `"Icon Travels" <${fromAddr}>`,
      to: normalizedEmail,
      subject: 'Your Icon Travels Verification Code - ' + otp,
      text: `Your verification code is: ${otp}\n\n(This email was sent to: ${normalizedEmail})\n\nThis code expires in 5 minutes. Do not share it with anyone.\n\nIcon Travels Team`,
      html: `<div style="font-family:Arial,sans-serif;"><h2>Icon Travels - Verification Code</h2><p>Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#1e3a5f;">${otp}</p><p style="margin-top:10px;color:#555;">This message is addressed to <strong>${normalizedEmail}</strong>.</p><p style="color:#666;">This code expires in 5 minutes. Do not share it with anyone.</p><p>Icon Travels Team</p></div>`
    });

    return res.json({ ok: true, message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('Send OTP error:', err);
    const msg = err.message || 'Failed to send OTP.';
    if (msg.includes('Email not configured') || msg.includes('Invalid login') || msg.includes('username and password') || msg.includes('Authentication failed')) {
      return res.status(500).json({ ok: false, message: 'Gmail not configured. Use Gmail App Password (not regular password). Run: firebase functions:config:set mail.user="your@gmail.com" mail.pass="your16charapppass"' });
    }
    return res.status(500).json({ ok: false, message: 'Could not send OTP: ' + msg });
  }
});

app.post('/verify-otp', async (req, res) => {
  try {
    // require auth token and derive email (same mechanism as /send-otp). This
    // prevents a user from verifying a code intended for a different account.
    let normalizedEmail;
    try {
      normalizedEmail = await getEmailFromRequest(req);
    } catch (e) {
      return res.status(401).json({ ok: false, message: 'Unauthorized (invalid or missing auth token)' });
    }

    const { otp } = req.body || {};
    if (!otp || typeof otp !== 'string') {
      return res.status(400).json({ ok: false, message: 'OTP is required.' });
    }
    const otpDigits = String(otp).replace(/\D/g, '');
    if (otpDigits.length !== 6) {
      return res.status(400).json({ ok: false, message: 'OTP must be 6 digits.' });
    }

    const otpRef = db.collection('otps').doc(normalizedEmail);
    const snap = await otpRef.get();
    if (!snap || !snap.exists) {
      return res.status(400).json({ ok: false, message: 'No OTP found. Please request a new one.' });
    }

    const data = snap.data();
    const { otp: storedOtp, expiresAt, attempts } = data;

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await otpRef.delete();
      return res.status(400).json({ ok: false, message: 'Too many attempts. Please request a new OTP.' });
    }

    if (Date.now() > expiresAt) {
      await otpRef.delete();
      return res.status(400).json({ ok: false, message: 'OTP has expired. Please request a new one.' });
    }

    await otpRef.update({ attempts: (attempts || 0) + 1 });

    if (storedOtp !== otpDigits) {
      const remaining = OTP_MAX_ATTEMPTS - (attempts || 0) - 1;
      return res.status(400).json({ ok: false, message: remaining > 0 ? `Invalid OTP. ${remaining} attempt(s) remaining.` : 'Invalid OTP. Please request a new one.' });
    }

    await otpRef.delete();
    return res.json({ ok: true, message: 'OTP verified successfully.' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ ok: false, message: 'Verification failed: ' + (err.message || 'unknown error') });
  }
});

exports.register = functions.https.onRequest(app);
exports.sendBookingConfirmation = functions.https.onRequest(app);
exports.otpApi = functions.https.onRequest(app);

