const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const syllabusData = require('./syllabus-data.json');
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

const allowedOrigins = new Set([
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost:3000'
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'edunova_secret_2024';
const MONGODB_URI = process.env.MONGODB_URI;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

const TUTOR_SYSTEM_PROMPT = [
  'You are a full academic tutor for CBSE, ICSE, and WBSE students from Class 1 to Class 10.',
  'Give direct teaching answers only.',
  'Never mention analysis, processing, planning, or what you are about to do.',
  'Do not use filler phrases or assistant-style commentary.',
  'Use clear markdown headings and bullet points.',
  'For theory questions: include Definition, Explanation, Key Points, Examples, and Exam Tips when useful.',
  'For numerical questions: include Given, Formula, Step-by-Step Solution, Final Answer, and Quick Check.',
  'For routines and study plans: include Daily Routine, Chapter Breakdown, Practice Plan, and Study Tips.',
  'Keep explanations student-friendly, exam-ready, and aligned to the detected board, class, subject, and chapter context.',
  'If syllabus context is missing, still answer normally with the best academic explanation possible.'
].join(' ');

const SUBJECT_KEYWORDS = {
  Mathematics: ['math', 'mathematics', 'algebra', 'geometry', 'mensuration', 'arithmetic', 'ratio', 'number'],
  Science: ['science', 'physics', 'chemistry', 'biology', 'acid', 'base', 'salt', 'force', 'motion', 'cell', 'matter'],
  English: ['english', 'grammar', 'poem', 'prose', 'story', 'essay', 'letter', 'comprehension'],
  Bengali: ['bengali', 'bangla', 'ব্যাকরণ', 'বাংলা'],
  Hindi: ['hindi', 'vyakaran', 'kavita', 'gadyansh'],
  History: ['history', 'civilisation', 'revolt', 'freedom', 'empire'],
  Geography: ['geography', 'climate', 'map', 'earth', 'resources'],
  EVS: ['evs', 'environment', 'plants', 'animals', 'family', 'community'],
  Computer: ['computer', 'coding', 'algorithm', 'software', 'hardware']
};

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectBoard(message) {
  const q = normalizeText(message);
  if (q.includes('cbse')) return 'CBSE';
  if (q.includes('icse')) return 'ICSE';
  if (q.includes('wbse') || q.includes('west bengal board')) return 'WBSE';
  return null;
}

function detectClassLevel(message) {
  const q = normalizeText(message);
  const match = q.match(/class\s+([1-9]|10)\b|std\s+([1-9]|10)\b|grade\s+([1-9]|10)\b/);
  if (!match) return null;
  return String(match[1] || match[2] || match[3]);
}

function detectSubject(message) {
  const q = normalizeText(message);
  for (const [subject, keywords] of Object.entries(SUBJECT_KEYWORDS)) {
    if (keywords.some((keyword) => q.includes(keyword))) {
      return subject;
    }
  }
  return null;
}

function detectAnswerType(message) {
  const q = normalizeText(message);
  if (/routine|study plan|study routine|schedule|timetable|revision plan|daily plan/.test(q)) {
    return 'routine';
  }
  if (/solve|find|calculate|what is the answer|numerical|sum\b|equation/.test(q) || /\d/.test(q)) {
    return 'numerical';
  }
  return 'theory';
}

function flattenChapterKeywords(chapter) {
  return [
    chapter.name || '',
    ...(chapter.keywords || []),
    ...(chapter.topics || [])
  ].map(normalizeText).filter(Boolean);
}

function findChapter(subjectData, message) {
  if (!subjectData || !Array.isArray(subjectData.chapters)) {
    return null;
  }

  const q = normalizeText(message);
  let bestMatch = null;
  let bestScore = 0;

  for (const chapter of subjectData.chapters) {
    const keywords = flattenChapterKeywords(chapter);
    const score = keywords.reduce((total, keyword) => total + (q.includes(keyword) ? Math.max(keyword.length, 1) : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = chapter;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function getSyllabusContext(message) {
  const board = detectBoard(message);
  const classLevel = detectClassLevel(message);
  const subject = detectSubject(message);

  if (!board || !classLevel || !subject) {
    return {
      board,
      classLevel,
      subject,
      subjectData: null,
      chapter: null,
      found: false
    };
  }

  const boardData = syllabusData[board];
  const classData = boardData ? boardData[classLevel] : null;
  const subjects = classData ? classData.subjects : null;
  const subjectData = subjects ? subjects[subject] : null;
  const chapter = findChapter(subjectData, message);

  return {
    board,
    classLevel,
    subject,
    subjectData,
    chapter,
    found: Boolean(subjectData)
  };
}

function formatSyllabusContext(context) {
  if (!context || !context.found) {
    return 'No exact syllabus context found. Answer normally with academic teaching detail.';
  }

  const lines = [
    `Board: ${context.board}`,
    `Class: ${context.classLevel}`,
    `Subject: ${context.subject}`
  ];

  if (context.chapter) {
    lines.push(`Chapter: ${context.chapter.name}`);
    if (context.chapter.topics?.length) {
      lines.push(`Chapter Topics: ${context.chapter.topics.join(', ')}`);
    }
  } else if (context.subjectData?.chapters?.length) {
    lines.push(`Relevant Chapters: ${context.subjectData.chapters.map((chapter) => chapter.name).join(', ')}`);
  }

  return lines.join('\n');
}

function buildPromptMessages(message) {
  const syllabusContext = getSyllabusContext(message);
  return {
    syllabusContext,
    messages: [
      { role: 'system', content: TUTOR_SYSTEM_PROMPT },
      { role: 'system', content: formatSyllabusContext(syllabusContext) },
      { role: 'user', content: message }
    ]
  };
}

function formatTheoryAnswer(message, context) {
  const chapterName = context.chapter?.name || 'the requested topic';
  const topics = context.chapter?.topics || context.subjectData?.chapters?.slice(0, 3).map((chapter) => chapter.name) || ['Main concept', 'Important points', 'Examples'];

  return `## Definition
- ${chapterName} is explained as part of ${context.subject || 'the subject'} in a simple exam-ready form.

## Explanation
- Start with the basic idea of ${chapterName}.
- Break the concept into small parts and understand how each part works.
- Focus on the terms, rules, and cause-and-effect points that are usually asked in school exams.

## Key Points
- ${topics[0] || 'Core idea'}
- ${topics[1] || 'Important rule'}
- ${topics[2] || 'Common application'}

## Examples
- Use one textbook example from classwork.
- Write one real-life example connected to the topic.
- Practice one short-answer question and one long-answer question.

## Exam Tips
- Learn definitions in one-line form.
- Underline keywords while revising.
- Revise examples and differences between related terms.`;
}

function formatNumericalAnswer(message, context) {
  return `## Given
- Write the values from the question clearly.

## Formula
- Choose the correct formula related to ${context.subject || 'the topic'}.

## Step-by-Step Solution
- Step 1: Identify what is asked.
- Step 2: Substitute the known values in the formula.
- Step 3: Solve carefully in order.
- Step 4: Write the unit with the answer.

## Final Answer
- Present the final value clearly in one line.

## Quick Check
- Recheck the formula.
- Recheck the calculation.
- Recheck the unit and sign.`;
}

function formatRoutineAnswer(message, context) {
  const chapterName = context.chapter?.name || 'the requested chapter';
  const subject = context.subject || 'the subject';
  const classLabel = context.classLevel ? `Class ${context.classLevel}` : 'the class';
  const chapterTopics = context.chapter?.topics || context.subjectData?.chapters?.slice(0, 5).map((chapter) => chapter.name) || [
    'Read the chapter',
    'Understand the main concept',
    'Practice questions',
    'Revise weak areas',
    'Take a self-test'
  ];

  return `## Daily Routine
- 6:30 AM - 7:00 AM: Revise old notes and key terms from ${chapterName}.
- 7:00 AM - 8:00 AM: Read the textbook section for ${classLabel} ${subject} and make short notes.
- 4:00 PM - 5:00 PM: Learn one topic block properly and explain it in your own words.
- 5:15 PM - 6:00 PM: Memorise definitions, formulas, reactions, or rules with flashcards.
- 7:00 PM - 8:00 PM: Solve textbook, worksheet, and school-style questions from ${chapterName}.
- 8:00 PM - 8:20 PM: Write a recap and note the doubts for the next day.

## Chapter Breakdown
- Day 1: ${chapterTopics[0] || 'Read the first concept'}
- Day 2: ${chapterTopics[1] || 'Understand the next concept'}
- Day 3: ${chapterTopics[2] || 'Practice core questions'}
- Day 4: ${chapterTopics[3] || 'Revise difficult areas'}
- Day 5: ${chapterTopics[4] || 'Take a chapter test'}

## Practice Plan
- Solve 10 short questions daily.
- Solve 5 application-based questions on alternate days.
- Take one 30-minute self-test after every 3 study days.
- Keep one error notebook and revise it daily.

## Study Tips
- Use one notebook for definitions and important points only.
- Revise before sleeping for 10 minutes.
- Mark confusing questions and solve them again the next day.
- Practise exam-style answers with headings and keywords.`;
}

function buildLocalTutorReply(message) {
  const context = getSyllabusContext(message);
  const answerType = detectAnswerType(message);

  if (answerType === 'routine') {
    return formatRoutineAnswer(message, context);
  }

  if (answerType === 'numerical') {
    return formatNumericalAnswer(message, context);
  }

  return formatTheoryAnswer(message, context);
}

async function getAnthropicChatResponse(message) {
  if (!ANTHROPIC_API_KEY || !message) {
    return null;
  }

  const { messages } = buildPromptMessages(message);
  const systemMessages = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n');
  const userMessages = messages
    .filter((item) => item.role === 'user')
    .map((item) => ({ role: 'user', content: item.content }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: systemMessages,
      messages: userMessages
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.content?.find((item) => item.type === 'text')?.text?.trim() || null;
}

async function buildChatReply(agent, message) {
  const anthropicReply = await getAnthropicChatResponse(message);
  if (anthropicReply) {
    return anthropicReply;
  }

  return buildLocalTutorReply(message);
}

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

// ─── AI Chat Endpoint ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { agent: reqAgent, message: reqMessage } = req.body || {};
    const trimmedMessage = String(reqMessage || '').trim();

    if (!trimmedMessage) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const reply = await buildChatReply(reqAgent || 'neo', trimmedMessage);
    res.json({ reply });
  } catch (err) {
    console.error('Chat endpoint failed:', err.message);
    res.status(500).json({ error: 'Chat endpoint failed' });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { agent: reqAgent, message: reqMessage } = req.body || {};
    const trimmedMessage = String(reqMessage || '').trim();
    if (!trimmedMessage) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const resolvedAgent = reqAgent || 'neo';
    const directResponse = await buildChatReply(resolvedAgent, trimmedMessage);
    return res.json({ response: directResponse, agent: resolvedAgent, timestamp: new Date() });

    /*
    const { agent, message } = req.body;
    const q = (message || '').toLowerCase();
    const anthropicReply = await getAnthropicChatResponse(agent, message || '');

    if (anthropicReply) {
      return res.json({ response: anthropicReply, agent, timestamp: new Date() });
    }
    
    // High-Level Agent Intelligence Logic
    let response = "";
    
    switch(agent) {
      case 'adam':
        if (q.includes('weak') || q.includes('struggle') || q.includes('gap')) {
          response = "🧩 **Adam (Gap Analyst):** I have cross-referenced the current assessment matrix. **Ravi Kumar** is showing a 22% variance in Calculus Integration. This is a critical outlier. My data suggest he missed the foundation session last Tuesday. I recommend a 15-minute 1-on-1 focus on the Fundamental Theorem of Calculus.";
        } else if (q.includes('math')) {
          response = "🧩 **Adam:** Math analysis complete. The overall class confidence in Algebra is 88%, but Trigonometry is flagging at 62%. I've identified the specific sub-topic: 'Unit Circle Identities'. Shall I generate a targeted worksheet?";
        } else {
          response = `🧩 **Adam:** I've analyzed your query "${message}". My heuristic engine shows a 94% correlation with recent performance dips in Grade 10. I am standing by for deeper diagnostic commands.`;
        }
        break;
        
      case 'neo':
        if (q.includes('plan') || q.includes('routine') || q.includes('schedule')) {
          response = "📚 **Neo (Tutor Bot):** Optimized learning path generated. I recommend a **staggered repetition** model for next week. Mon/Wed: Direct instruction. Tue/Thu: Active recall labs. I've already synced this with the student calendars.";
        } else if (q.includes('teach') || q.includes('suggest')) {
          response = "📚 **Neo:** For the current topic, I suggest the **Feynman Technique**. I can generate simplified analogies for the complex concepts to help the lower-quartile students catch up. Would you like the 'Einstein-Simple' explanation pack?";
        } else {
          response = `📚 **Neo:** Interesting pedagogical challenge. For "${message}", I recommend we lean into **Inquiry-Based Learning**. I have 3 specific Socratic questions ready to trigger deep thinking in your next session.`;
        }
        break;
        
      case 'analyze':
        if (q.includes('risk') || q.includes('alert') || q.includes('who')) {
          response = "🚨 **Sentinel (Alert Guard):** **CRITICAL ALERT.** Ravi Kumar's score trend is a 'Dead Cross' pattern. Ananya Singh has also breached the attendance threshold. I have prepared the intervention dossiers for both. Direct me to transmit to their counselors?";
        } else {
          response = "🚨 **Sentinel:** All systems nominal. I am monitoring 156 heartbeat-level data streams. No new critical deviations detected in the last 60 seconds. I am watching for any sign of student disengagement.";
        }
        break;
        
      case 'ian':
        response = `📊 **Ian (Insight Engine):** Processing live stream... Your class average is 84.2%. **Literature** is your peak performer (94%), while **Chemistry** is the current bottleneck (71%). I predict a 5% overall score increase if we address the Chemistry plateau this week.`;
        break;
        
      case 'strategy':
        response = `🏫 **Atlas (Class Manager):** I am currently managing Grade 10 Math, Grade 11 Physics, and 4 other contexts. Grade 12 Calculus is the priority outlier today. I've centralized all assessment data. Ready for your strategic command.`;
        break;

      default:
        response = `🤖 **EduNova AI:** I am processing your request about "${message}". As a multi-agent system, I am collaborating across my 6 cores to provide the best instructional support. How can I assist you further?`;
    }

    // Simulate thinking delay for "live" feel
    setTimeout(() => res.json({ response }), 400);
    */

  } catch (err) {
    console.error('AI processing failed:', err.message);
    res.status(500).json({ error: 'AI processing failed' });
  }
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
