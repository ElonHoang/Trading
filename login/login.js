const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let csrf = null;
let passwordLoginEnabled = false;
const loginError = params.get('error');

function safeReturnTo(value) {
  return value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    && !/[\u0000-\u001F\u007F]/.test(value) ? value : '/';
}

const returnTo = safeReturnTo(params.get('returnTo'));
const messages = {
  provider_not_configured: 'Phương thức đăng nhập này chưa được cấu hình trên máy chủ.',
  access_denied: 'Bạn đã huỷ yêu cầu đăng nhập. Không có thay đổi nào được thực hiện.',
  invalid_state: 'Phiên đăng nhập đã hết hạn. Vui lòng thử lại.',
  missing_code: 'Nhà cung cấp không gửi mã xác nhận. Vui lòng thử lại.',
  oauth_failed: 'Không thể hoàn tất đăng nhập lúc này. Vui lòng thử lại sau.',
  invalid_credentials: 'Tên đăng nhập hoặc mật khẩu không đúng. Vui lòng thử lại.',
};

function showNotice(message) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = false;
}

function configureProvider(id, provider, enabled) {
  const button = $(id);
  button.href = `/auth/${provider}?${new URLSearchParams({ returnTo })}`;
  if (enabled) return;
  button.setAttribute('aria-disabled', 'true');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    showNotice(`${provider === 'google' ? 'Google' : 'GitHub'} chưa được cấu hình. Hãy thêm OAuth Client ID và Client Secret vào file .env.`);
  });
}

function configurePasswordLogin(enabled) {
  passwordLoginEnabled = enabled;
  const form = $('password-login-form');
  form.setAttribute('aria-disabled', String(!enabled));
  for (const control of form.querySelectorAll('input:not([type="hidden"]), button')) {
    control.disabled = !enabled;
  }
  $('password-login-help').hidden = enabled;
  $('password-login-return-to').value = returnTo;
  if (csrf) {
    $('password-login-csrf').name = csrf.parameterName || '_csrf';
    $('password-login-csrf').value = csrf.token;
  }
}

function showUser(user) {
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('user-name').textContent = user.name || 'Xin chào';
  $('user-email').textContent = user.email || (user.provider === 'password'
    ? 'Đăng nhập bằng tài khoản nội bộ'
    : `Đăng nhập bằng ${user.provider}`);
  $('continue-button').href = returnTo;
  const avatar = $('user-avatar');
  if (user.avatar) avatar.src = user.avatar;
  else avatar.hidden = true;
}

async function init() {
  if (loginError) showNotice(messages[loginError] || 'Đăng nhập không thành công. Vui lòng thử lại.');

  try {
    const response = await fetch('/api/auth/session', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const session = await response.json();
    csrf = session.csrf || null;
    configurePasswordLogin(session.providers.password);
    configureProvider('google-login', 'google', session.providers.google);
    configureProvider('github-login', 'github', session.providers.github);
    if (loginError === 'invalid_credentials' && session.providers.password) $('username').focus();
    if (session.user) showUser(session.user);
  } catch {
    configurePasswordLogin(false);
    configureProvider('google-login', 'google', false);
    configureProvider('github-login', 'github', false);
    showNotice('Không thể kết nối tới máy chủ đăng nhập. Vui lòng tải lại trang.');
  }
}

$('password-login-form').addEventListener('submit', (event) => {
  if (!passwordLoginEnabled || !csrf) {
    event.preventDefault();
    showNotice('Đăng nhập bằng tên đăng nhập và mật khẩu chưa được cấu hình trên máy chủ.');
    return;
  }
  $('password-login-submit').disabled = true;
  $('password-login-label').textContent = 'Đang đăng nhập…';
});

$('logout-button').addEventListener('click', async () => {
  const button = $('logout-button');
  button.disabled = true;
  button.textContent = 'Đang đăng xuất…';
  try {
    const headers = csrf ? { [csrf.headerName]: csrf.token } : {};
    const response = await fetch('/auth/logout', { method: 'POST', headers });
    if (!response.ok) throw new Error();
    location.assign(`/login/?${new URLSearchParams({ returnTo })}`);
  } catch {
    button.disabled = false;
    button.textContent = 'Đăng xuất';
    showNotice('Không thể đăng xuất lúc này. Vui lòng thử lại.');
  }
});

init();
