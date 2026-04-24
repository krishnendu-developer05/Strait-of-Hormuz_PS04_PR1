// Theme toggle
const THEME_KEY = 'edunova_theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const toggle = document.querySelector('.toggle-switch');
  if (toggle) toggle.classList.toggle('light', theme === 'light');
  const icon = document.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}

// Toast notifications
function showToast(message, type = 'success', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || '📢'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// API helper
const API_BASE = '/api';
function getToken() { return localStorage.getItem('edunova_token'); }
function getUser() { return JSON.parse(localStorage.getItem('edunova_user') || '{}'); }

async function apiCall(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Number animation
function animateCount(el, target, duration = 1500) {
  const start = 0;
  const step = target / (duration / 16);
  let current = start;
  const timer = setInterval(() => {
    current = Math.min(current + step, target);
    el.textContent = Math.round(current);
    if (current >= target) clearInterval(timer);
  }, 16);
}

// Format date
function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Generate avatar initials
function getInitials(name) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

// Ripple effect
function addRipple(el) {
  el.addEventListener('click', function(e) {
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size/2}px;top:${e.clientY - rect.top - size/2}px`;
    el.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  });
}

// Check auth
function requireAuth() {
  if (!getToken()) { window.location.href = '/auth/login.html'; return false; }
  return true;
}

// Sidebar active state
function setActiveNav(href) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('href') === href || window.location.pathname.includes(item.getAttribute('href')));
  });
}

// Init on load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  // Theme toggle button
  const toggleBtn = document.querySelector('.toggle-switch');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleTheme);
  // Active nav
  setActiveNav(window.location.pathname);
  // Ripple buttons
  document.querySelectorAll('.btn-primary').forEach(addRipple);
  // Page entrance
  document.body.classList.add('page-enter');
  // User info
  const user = getUser();
  const userAvatarEls = document.querySelectorAll('.user-avatar');
  userAvatarEls.forEach(el => { if (user.name) el.textContent = getInitials(user.name); });
  const userNameEls = document.querySelectorAll('.user-name');
  userNameEls.forEach(el => { if (user.name) el.textContent = user.name; });
});
