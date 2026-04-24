const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'edunova_secret_2024';
const MONGODB_URI = process.env.MONGODB_URI;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// ─── Razorpay Initialization ───────────────────────────────────────────────
let razorpay;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });
  console.log('✅ Razorpay initialized');
} else {
  console.warn('⚠️ Razorpay credentials missing. Payment system will be in mock mode.');
}

// ─── MongoDB Connection ────────────────────────────────────────────────────
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
} else {
  console.warn('⚠️ MONGODB_URI missing. Database will not be connected.');
}

// ─── Mongoose Models ───────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: { type: String, select: false },
  role: { type: String, default: 'teacher' },
  plan: { type: String, default: 'starter' },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const ClassSchema = new mongoose.Schema({
  name: String,
  teacherId: mongoose.Schema.Types.ObjectId,
  subject: String,
  studentCount: { type: Number, default: 0 },
  color: String
});
const Class = mongoose.model('Class', ClassSchema);

const StudentSchema = new mongoose.Schema({
  name: String,
  classId: mongoose.Schema.Types.ObjectId,
  email: String,
  alertLevel: { type: String, default: 'none' },
  scores: {
    Math: [Number],
    Science: [Number],
    English: [Number],
    History: [Number]
  }
});
const Student = mongoose.model('Student', StudentSchema);

const AlertSchema = new mongoose.Schema({
  studentId: mongoose.Schema.Types.ObjectId,
  studentName: String,
  subject: String,
  score: Number,
  threshold: Number,
  severity: String,
  triggeredAt: { type: Date, default: Date.now },
  resolved: { type: Boolean, default: false }
});
const Alert = mongoose.model('Alert', AlertSchema);

// ─── Auth Middleware ───────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, plan: user.plan } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already exists' });
    
    const user = new User({ name, email, password: bcrypt.hashSync(password, 10), role: role || 'teacher' });
    await user.save();
    
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name, email, role: user.role, plan: user.plan } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, plan: user.plan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── STUDENTS ROUTES ─────────────────────────────────────────────────────
app.get('/api/students', authMiddleware, async (req, res) => {
  try {
    const { classId } = req.query;
    let query = {};
    if (classId) query.classId = classId;
    
    const students = await Student.find(query);
    const enriched = students.map(s => {
      const allScores = Object.values(s.scores).flat();
      const avg = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;
      return { ...s.toObject(), id: s._id, avgScore: Math.round(avg) };
    });
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/students', authMiddleware, async (req, res) => {
  try {
    const student = new Student(req.body);
    await student.save();
    res.json(student);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CLASSES ROUTES ──────────────────────────────────────────────────────
app.get('/api/classes', authMiddleware, async (req, res) => {
  try {
    const classes = await Class.find({ teacherId: req.user.id });
    res.json(classes.map(c => ({ ...c.toObject(), id: c._id })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/classes', authMiddleware, async (req, res) => {
  try {
    const colors = ['#6C63FF','#00D4FF','#00E5A0','#FFB547','#FF5757'];
    const newClass = new Class({ 
      teacherId: req.user.id, 
      color: colors[Math.floor(Math.random() * colors.length)], 
      ...req.body 
    });
    await newClass.save();
    res.json(newClass);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ANALYTICS ROUTES ────────────────────────────────────────────────────
app.get('/api/analytics/overview', authMiddleware, async (req, res) => {
  try {
    const students = await Student.find();
    const totalStudents = students.length;
    const atRisk = students.filter(s => s.alertLevel !== 'none').length;
    const allScores = students.flatMap(s => Object.values(s.scores).flat());
    const avgScore = allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;
    const classesCount = await Class.countDocuments({ teacherId: req.user.id });
    
    res.json({ totalStudents, atRisk, avgScore, totalClasses: classesCount, weeklyTrends: [72, 75, 73, 78, 80, 82, 79] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AI AGENTS ROUTES ────────────────────────────────────────────────────
const aiResponses = {
  adam: (query) => {
    const ql = query.toLowerCase();
    if (ql.includes('weak') || ql.includes('gap')) return `🧩 **Adam: High-Fidelity Gap Analysis**\n\nI have isolated the primary struggle points in your cohort. Calculus Integration is at 42% failing to meet standard. I recommend immediate remedial session 4B.`;
    return `🧩 **Adam:** I've analyzed your query "${query}". My confidence in current performance data is 98.4%.`;
  },
  neo: (query) => {
    const ql = query.toLowerCase();
    if (ql.includes('routine') || ql.includes('plan')) return `📚 **Neo: Dynamic Schedule Generated**\n\nI have optimized the learning routine for peak cognitive performance. Mathematics and Physics are prioritized for Monday-Wednesday.`;
    return `📚 **Neo:** I've prepared several teaching strategies for "${query}". The "Active Recall" pathway is my top recommendation.`;
  },
  analyze: (query) => `🚨 **Sentinel: Priority Monitoring Active**\n\nSystem state: TOTAL ACTIVITY DETECTED. I am tracking 7 at-risk students. Ravi Kumar and Ananya Singh are in the critical red-zone.`,
  ian: (query) => `📊 **Ian: Insight Engine Live**\n\nData processing at 100% capacity. Your class average is 84.2%. Literature shows an upward trend, while Chemistry is concerning.`,
  strategy: (query) => `🏫 **Atlas: Global Command**\n\nI have centralized all class contexts. Grade 10 Chemistry is the priority outlier. I am ready to sync instructional goals.`
};

app.post('/api/ai/chat', authMiddleware, (req, res) => {
  const { agent, message } = req.body;
  const response = aiResponses[agent] ? aiResponses[agent](message) : "I'm here to assist you with student learning analytics.";
  res.json({ response, agent, timestamp: new Date() });
});

// ─── PAYMENTS (RAZORPAY) ──────────────────────────────────────────────────
app.post('/api/payments/create-order', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;
    const plans = {
      pro: { amount: 29, currency: 'USD' },
      institution: { amount: 199, currency: 'USD' }
    };
    const selected = plans[plan];
    if (!selected) return res.status(400).json({ error: 'Invalid plan' });

    if (!razorpay) {
      // Mock order for testing when keys are missing
      return res.json({ 
        id: 'order_mock_' + Date.now(), 
        amount: selected.amount * 100 * 83, // Mock INR conversion
        currency: 'INR',
        key_id: 'rzp_test_mock_key',
        mock: true
      });
    }

    const options = {
      amount: selected.amount * 100 * 83, // Convert to Paise (approx conversion to INR)
      currency: 'INR',
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    res.json({ ...order, key_id: RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payments/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    
    // Handle mock verification
    if (razorpay_order_id.startsWith('order_mock_')) {
      await User.findByIdAndUpdate(req.user.id, { plan: plan });
      return res.json({ success: true, message: 'Mock payment verified' });
    }

    const hmac = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');

    if (generated_signature === razorpay_signature) {
      await User.findByIdAndUpdate(req.user.id, { plan: plan });
      res.json({ success: true, message: 'Payment verified successfully' });
    } else {
      res.status(400).json({ error: 'Invalid payment signature' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected'));
});

// ─── SERVE FRONTEND ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎓 EduNova AI running at http://localhost:${PORT}\n`));

