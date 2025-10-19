import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ------------------ CONFIG ------------------
const SUPABASE_URL = "https://bftwskejmvopnpcdgmua.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJmdHdza2VqbXZvcG5wY2RnbXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA3MzgxNDAsImV4cCI6MjA3NjMxNDE0MH0.VOlRyhAsf8AX09urInqe2R8473TQzAeiOzwR4yVn8JU";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------ UI refs ------------------
const sidebar = document.getElementById('sidebar');
const hamburger = document.getElementById('hamburger');
const navLinks = document.querySelectorAll('.nav a');
const sections = document.querySelectorAll('.section');
const userEmailEl = document.getElementById('userEmail');
const balanceEl = document.getElementById('balance');
const qLimitEl = document.getElementById('qLimit');
const accountStatusEl = document.getElementById('accountStatus');
const questionsContainer = document.getElementById('questionsContainer');
const myAnswersContainer = document.getElementById('myAnswersContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const paymentStatus = document.getElementById('paymentStatus');
const withdrawMessage = document.getElementById('withdrawMessage');
const submitModal = document.getElementById('submitModal');
const modalQuestionText = document.getElementById('modalQuestionText');
const answerFile = document.getElementById('answerFile');
const submitFeedback = document.getElementById('submitFeedback');

// state
let user = null;
let profile = null;
let questions = [];
let currentQuestionId = null;

// ------------------ helpers ------------------
function showSidebar(open){
  if(open) sidebar.classList.add('open'); else sidebar.classList.remove('open');
}

function setActiveSection(id){
  // Hide all sections
  sections.forEach(s => s.classList.remove('active'));
  
  // Show only the active section
  const activeSection = document.getElementById(id);
  if (activeSection) {
    activeSection.classList.add('active');
  }
  
  // Update navigation
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.section === id));
  
  // Save active section
  localStorage.setItem('activeSection', id);
  
  // Collapse drawer on mobile
  if(window.innerWidth <= 900) showSidebar(false);
}

function todayISO(){ return new Date().toISOString().slice(0,10); }
function escapeHtml(s){ if(!s && s !== 0) return ""; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

// ------------------ Auth & initial load ------------------
async function init(){
  const { data: { user: u } } = await supabase.auth.getUser();
  if(!u) { location.href = 'index.html'; return; }
  user = u;
  userEmailEl.textContent = user.email;

  // load profile
  const { data, error } = await supabase.from('profiles').select('*').eq('email', user.email).single();
  if(error || !data){
    console.error('Profile load error', error);
    alert('Could not load profile. Contact admin.');
    return;
  }
  profile = data;
  renderProfile();

  // load questions + my answers
  await loadQuestions();
  await loadMyAnswers();
  updateProgress();

  // restore section
  const last = localStorage.getItem('activeSection') || 'overview';
  setActiveSection(last);

  // Set up realtime updates
  setupRealtimeUpdates();
}

function renderProfile(){
  balanceEl.textContent = (profile.balance || 0) + ' KSH';
  qLimitEl.textContent = profile.upgraded ? '3 / day' : '1 / day';
  accountStatusEl.textContent = profile.status || 'pending';
}

// ------------------ QUESTIONS ------------------
async function loadQuestions(){
  const { data: qs, error } = await supabase.from('questions').select('*').order('created_at', { ascending:false });
  if(error){ console.error('questions err', error); questionsContainer.innerHTML='<div class="muted">Could not load questions.</div>'; return; }
  questions = qs || [];
  if(questions.length===0) { questionsContainer.innerHTML = '<div class="muted">No questions yet.</div>'; return; }

  questionsContainer.innerHTML = '';
  for(const q of questions){
    const el = document.createElement('div');
    el.className = 'question';
    el.innerHTML = `
      <div class="q-left">
        <div class="q-title">${escapeHtml(q.question_text)}</div>
        <div class="q-meta">Pay: <strong>${q.pay_amount} KSH</strong> • Added: ${new Date(q.created_at).toLocaleDateString()}</div>
      </div>
      <div class="actions">
        <button class="btn-ghost answer-btn" data-id="${q.id}">Answer</button>
      </div>
    `;
    questionsContainer.appendChild(el);
  }

  // attach handlers
  questionsContainer.querySelectorAll('.answer-btn').forEach(b=>{
    b.addEventListener('click', (e)=>{
      const id = parseInt(b.dataset.id);
      openSubmitModal(id);
    });
  });
}

// ------------------ SUBMIT ANSWER (modal, storage, insert) ------------------
function openSubmitModal(questionId){
  const limit = profile.upgraded ? 3 : 1;
  const today = todayISO();
  if(profile.last_answer_date === today && (profile.answers_today || 0) >= limit){
    return alert(`You have reached your daily limit (${limit}). Upgrade to answer more.`);
  }
  currentQuestionId = questionId;
  const q = questions.find(x => x.id === questionId);
  modalQuestionText.textContent = q ? q.question_text : ('Question #' + questionId);
  submitFeedback.textContent = '';
  answerFile.value = '';
  submitModal.classList.add('open');
  submitModal.setAttribute('aria-hidden', 'false');
}

document.getElementById('submitAnswerBtn').addEventListener('click', async () => {
  submitFeedback.textContent = '';
  const file = answerFile.files[0];
  if(!file) return submitFeedback.textContent = 'Please select a PDF.';
  if(file.type !== 'application/pdf') return submitFeedback.textContent = 'Only PDF allowed.';
  if(file.size > 10 * 1024 * 1024) return submitFeedback.textContent = 'Max 10MB allowed.';
  if(!currentQuestionId) return submitFeedback.textContent = 'No question selected.';

  try{
    // Upload PDF to Supabase Storage
    const safeEmail = user.email.replace(/[@.]/g,'_');
    const path = `${safeEmail}/${Date.now()}_${file.name}`;
    const { data: uploadData, error: uploadError } = await supabase
      .storage.from('answers')
      .upload(path, file);
    if(uploadError) throw uploadError;

    // Get signed URL (7 days for better user experience)
    const { data: signed } = await supabase
      .storage.from('answers')
      .createSignedUrl(path, 60*60*24*7); // 7 days

    // CRITICAL FIX: Get current user ID and include it in the insert
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    
    // Insert into answers table WITH user_id
    const { error: insertErr } = await supabase.from('answers').insert([{
      user_id: currentUser.id,  // ← CRITICAL: This fixes the NULL user_id issue
      user_email: user.email,
      question_id: currentQuestionId,
      file_url: signed.signedUrl,
      status: 'pending',
      earned: 0, // start at 0 until admin approves
      created_at: new Date().toISOString()
    }]);
    if(insertErr) throw insertErr;

    // Update profile counters (last_answer_date + answers_today)
    const today = todayISO();
    let newCount = 1;
    if(profile.last_answer_date === today) newCount = (profile.answers_today || 0) + 1;
    const { error: updErr } = await supabase.from('profiles')
      .update({ last_answer_date: today, answers_today: newCount })
      .eq('id', profile.id);
    if(!updErr){
      profile.last_answer_date = today;
      profile.answers_today = newCount;
    }

    // Refresh "My Submitted Answers" immediately
    await loadMyAnswers();
    renderProfile();

    submitModal.classList.remove('open');
    submitModal.setAttribute('aria-hidden', 'true');
    alert('Answer submitted — pending admin review.');

  }catch(err){
    console.error(err);
    alert('Submission failed: ' + (err.message || err));
  }
});

// ------------------ LOAD MY ANSWERS (with table view) ------------------
async function loadMyAnswers(){
  const { data: ans, error } = await supabase.from('answers')
    .select(`
      id, 
      question_id, 
      file_url, 
      status, 
      earned, 
      created_at,
      questions!fk_answers_question_id (question_text, pay_amount)
    `)
    .eq('user_email', user.email)
    .order('created_at', { ascending: false });

  if(error){ 
    console.error('ANSWERS ERROR DETAILS:', error.message, error.details, error.hint);
    myAnswersContainer.innerHTML = '<div class="muted">Could not load answers.</div>'; 
    return; 
  }
  
  if(!ans || ans.length===0){ 
    myAnswersContainer.innerHTML = '<div class="muted">You have not submitted any answers yet.</div>'; 
    return; 
  }

  myAnswersContainer.innerHTML = '';
  
  // Create a table-like structure
  const table = document.createElement('div');
  table.style.cssText = `
    display: table;
    width: 100%;
    background: #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    margin-top: 16px;
    border-collapse: collapse;
  `;
  
  // Table header
  const header = document.createElement('div');
  header.style.cssText = `
    display: table-row;
    background: var(--g2);
    color: white;
    font-weight: 600;
  `;
  header.innerHTML = `
    <div style="display: table-cell; padding: 12px;">Job / Question</div>
    <div style="display: table-cell; padding: 12px;">Pay</div>
    <div style="display: table-cell; padding: 12px;">Status</div>
    <div style="display: table-cell; padding: 12px;">Actions</div>
  `;
  table.appendChild(header);

  // Table rows
  for(const a of ans){
    const questionText = a.questions?.question_text || `Question #${a.question_id}`;
    const payAmount = a.questions?.pay_amount || 0;
    const earnedAmount = a.earned || 0;
    
    const row = document.createElement('div');
    row.style.cssText = `
      display: table-row;
      background: white;
    `;
    
    row.innerHTML = `
      <div style="font-weight: 500;">${escapeHtml(questionText)}</div>
      <div>${payAmount} KSH</div>
      <div>
        <span style="
          padding: 4px 8px;
          border-radius: 12px;
          font-size: 0.8rem;
          font-weight: 600;
          background: ${a.status === 'approved' ? '#10b981' : a.status === 'rejected' ? '#ef4444' : '#f59e0b'};
          color: white;
        ">${escapeHtml(a.status)}</span>
        ${earnedAmount > 0 ? `<div style="font-size: 0.8rem; margin-top: 4px;">Earned: ${earnedAmount} KSH</div>` : ''}
      </div>
      <div>
        <a class="btn-ghost" href="${a.file_url}" target="_blank" rel="noopener">View PDF</a>
      </div>
    `;
    table.appendChild(row);
  }
  
  myAnswersContainer.appendChild(table);
}

// ------------------ REALTIME UPDATES ------------------
function setupRealtimeUpdates() {
  // Balance updates
  if(profile?.id){
    supabase
      .channel(`public:profiles:id=eq.${profile.id}`)
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: 'profiles', 
        filter: `id=eq.${profile.id}` 
      }, payload => {
        profile.balance = payload.new.balance;
        balanceEl.textContent = profile.balance + ' KSH';
        updateProgress();
      })
      .subscribe();
  }

  // Answer updates (new feature)
  supabase
    .channel('answer-updates')
    .on('postgres_changes', 
      { 
        event: '*', 
        schema: 'public', 
        table: 'answers',
        filter: `user_email=eq.${user.email}`
      }, 
      async (payload) => {
        console.log('Answer updated:', payload);
        // Refresh the answers table when answers change
        await loadMyAnswers();
        
        // Also refresh profile to get latest balance
        const { data: freshProfile } = await supabase.from('profiles')
          .select('balance')
          .eq('email', user.email)
          .single();
          
        if(freshProfile) {
          profile.balance = freshProfile.balance;
          balanceEl.textContent = freshProfile.balance + ' KSH';
          updateProgress();
        }
      }
    )
    .subscribe();
}

// ------------------ UPGRADE (send ref code) ------------------
document.getElementById('sendRefBtn').addEventListener('click', async ()=>{
  const ref = document.getElementById('mpesaRef').value.trim();
  if(!ref) return alert('Enter M-Pesa reference code.');
  const { error } = await supabase.from('payments').insert([{ user_id: profile.id, amount: 500, ref_code: ref, status: 'pending' }]);
  if(error){ console.error(error); alert('Failed: '+error.message); return; }
  paymentStatus.textContent = 'Reference sent — admin will confirm.';
  alert('Reference sent.');
});

// ------------------ WITHDRAW ------------------
function updateProgress(){
  const bal = Number(profile.balance || 0);
  const percent = Math.min(Math.round((bal / 5000) * 100), 100);
  progressBar.style.width = percent + '%';
  progressText.textContent = `${bal}/5000 KSH`;
}

document.getElementById('withdrawBtn').addEventListener('click', async ()=>{
  const bal = Number(profile.balance || 0);
  if(bal < 5000) return alert('You need at least 5000 KSH to withdraw.');
  const phone = document.getElementById('mpesaPhone').value.trim();
  if(!phone) return alert('Enter your M-Pesa phone number.');
  const { error } = await supabase.from('payments').insert([{ user_id: profile.id, amount: -bal, ref_code: phone, status: 'withdraw_requested' }]);
  if(error){ console.error(error); alert('Failed: '+error.message); return; }
  withdrawMessage.textContent = 'Withdrawal requested — admin will process.';
  alert('Withdrawal requested.');
});

// ------------------ NAV events ------------------
navLinks.forEach(a=>{
  a.addEventListener('click', (e)=>{
    e.preventDefault();
    const id = a.dataset.section;
    setActiveSection(id);
  });
});
document.getElementById('openAvailable').addEventListener('click', ()=> setActiveSection('available'));
document.getElementById('openAnswers').addEventListener('click', ()=> setActiveSection('myanswers'));
document.getElementById('startAnswer').addEventListener('click', ()=> {
  if(questions.length) openSubmitModal(questions[0].id);
  else alert('No questions available yet.');
  setActiveSection('available');
});

// sidebar drawer control
hamburger.addEventListener('click', ()=> sidebar.classList.toggle('open'));
// if user clicks outside sidebar on small screen, close drawer
window.addEventListener('click', (e)=>{
  if(window.innerWidth <= 900){
    const isClickInside = sidebar.contains(e.target) || hamburger.contains(e.target);
    if(!isClickInside) sidebar.classList.remove('open');
  }
});

// modal close handlers
document.getElementById('closeModal').addEventListener('click', ()=>{ 
  submitModal.classList.remove('open'); 
  submitModal.setAttribute('aria-hidden','true');
});
document.getElementById('cancelAnswerBtn').addEventListener('click', ()=>{ 
  submitModal.classList.remove('open'); 
  submitModal.setAttribute('aria-hidden','true'); 
});

// logout handler
document.getElementById('logoutBtn').addEventListener('click', async ()=>{
  await supabase.auth.signOut();
  location.href = 'index.html';
});

// start everything
await init();



