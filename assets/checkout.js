(() => {
  const API_BASE = String(window.PAYHUB_CONFIG?.apiBase || '').replace(/\/$/, '');
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session_id') || '';
  const $ = (selector) => document.querySelector(selector);

  const els = {
    title: $('#checkoutTitle'), summaryDescription: $('#summaryDescription'), summary: $('#summary'), order: $('#order'), country: $('#country'),
    totalBlock: $('#totalBlock'), amount: $('#amount'), loadingState: $('#loadingState'), paidState: $('#paidState'),
    providerChooser: $('#providerChooser'), providerOptions: $('#providerOptions'), providerHint: $('#providerHint'),
    tossCheckout: $('#tossCheckout'), tossPayButton: $('#tossPayButton'), tossPayButtonLabel: $('#tossPayButtonLabel'),
    bankCheckout: $('#bankCheckout'), bankOptions: $('#bankOptions'), bankPayButton: $('#bankPayButton'),
    aqrCheckout: $('#aqrCheckout'), aqrStartButton: $('#aqrStartButton'), aqrWidgetContainer: $('#aqrWidgetContainer'), aqrWaiting: $('#aqrWaiting'),
    hostedCheckout: $('#hostedCheckout'), hostedProviderName: $('#hostedProviderName'), hostedCheckoutCopy: $('#hostedCheckoutCopy'), hostedPayButton: $('#hostedPayButton'),
    errorBox: $('#errorBox'), infoBox: $('#infoBox'), buildVersion: $('#buildVersion'),
  };

  let session = null;
  let providerOptions = [];
  let activeProvider = '';
  let tossWidgets = null;
  let busy = false;
  let journalCheckout = false;
  let depositPollTimer = null;
  // An explicit, tightly scoped product description; never apply to other PayHub merchants.
  const isJournalTestOrder = (value) => /^기쁜사이 (?:5|10)회 이용권 \(TEST\)$/.test(String(value || ''));

  const api = (path, options = {}) => fetch(API_BASE + path, options);
  const hide = (el) => el?.classList.add('hidden');
  const show = (el) => el?.classList.remove('hidden');

  function money(amount, currency) {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency', currency,
      maximumFractionDigits: ['KRW', 'JPY'].includes(currency) ? 0 : 2,
    }).format(amount / (['KRW', 'JPY'].includes(currency) ? 1 : 100));
  }

  function setBuildVersion() {
    if (!els.buildVersion) return;
    const build = String(window.PAYHUB_CONFIG?.buildId || 'local');
    const commit = String(window.PAYHUB_CONFIG?.sourceCommit || 'local');
    els.buildVersion.textContent = build === 'local' ? 'local' : `${build} · ${commit.slice(0, 8)}`;
  }

  function showError(message) { els.errorBox.textContent = message; show(els.errorBox); }
  function clearError() { els.errorBox.textContent = ''; hide(els.errorBox); }
  function showInfo(message) { els.infoBox.textContent = message; show(els.infoBox); }

  function paymentErrorMessage(code) {
    const messages = {
      PAY_PROCESS_CANCELED: '결제가 취소되었습니다. 결제수단을 다시 선택해 주세요.',
      PAY_PROCESS_ABORTED: '결제가 중단되었습니다. 다른 결제수단을 선택하거나 다시 시도해 주세요.',
      REJECT_CARD_COMPANY: '결제 승인이 거절되었습니다. 다른 카드 또는 결제수단을 선택해 주세요.',
      USER_CANCEL: '결제가 취소되었습니다. 결제수단을 다시 선택해 주세요.',
    };
    return messages[code] || '결제가 완료되지 않았습니다. 결제수단을 다시 선택해 주세요.';
  }

  function renderReturnState() {
    const code = params.get('payment_error') || '';
    const cancelled = params.get('cancelled') === '1';
    if (code) showInfo(paymentErrorMessage(code));
    else if (cancelled) showInfo('결제가 취소되었습니다. 결제수단을 다시 선택해 주세요.');
  }

  function renderSummary(s) {
    journalCheckout = isJournalTestOrder(s.description);
    document.body.classList.toggle('journal-checkout', journalCheckout);
    els.title.textContent = journalCheckout ? s.description.replace(' (TEST)', '') : (s.description || '결제');
    els.summaryDescription.textContent = '주문 정보를 확인하고 결제수단을 선택해 주세요.';
    els.order.textContent = s.order_id;
    els.country.textContent = `${s.country} · ${s.currency}`;
    els.amount.textContent = money(s.amount, s.currency);
    els.tossPayButtonLabel.textContent = `${money(s.amount, s.currency)} 결제하기`;
    show(els.summary); show(els.totalBlock);
  }

  function normalizeProviderOptions(s) {
    const labels = { toss: 'TossPayments', stripe: 'Stripe', paypal: 'PayPal', bank_transfer:'계좌이체', aqr_transfer:'무료 계좌송금' };
    const flows = { toss: 'embedded', stripe: 'hosted', paypal: 'hosted', bank_transfer:'bank_consent', aqr_transfer:'aqr_widget' };
    if (Array.isArray(s.provider_options) && s.provider_options.length) {
      return s.provider_options.map((p) => ({
        id: String(p.id || '').toLowerCase(),
        name: String(p.name || labels[p.id] || p.id),
        mode: String(p.mode || 'test').toLowerCase(),
        flow: String(p.flow || flows[p.id] || 'hosted').toLowerCase(),
      })).filter((p) => p.id === 'toss' || p.id === 'stripe' || p.id === 'paypal' || p.id === 'bank_transfer' || p.id === 'aqr_transfer');
    }
    return (Array.isArray(s.providers) ? s.providers : []).map((id) => ({
      id, name: labels[id] || id, mode: 'test', flow: flows[id] || 'hosted',
    })).filter((p) => p.id === 'toss' || p.id === 'stripe' || p.id === 'paypal' || p.id === 'bank_transfer' || p.id === 'aqr_transfer');
  }

  function providerMeta(id) {
    if (id === 'toss') return { title: 'TossPayments', detail: '국내 카드 · 앱카드 · 간편결제' };
    if (id === 'stripe') return { title: 'Stripe', detail: '해외 카드 · 현지 결제수단' };
    if (id === 'paypal') return { title: 'PayPal', detail: '미국 PayPal 계정 결제 · USD' };
    if (id === 'bank_transfer') return { title: '계좌이체', detail: '내 은행 선택 · 금융결제원 계좌 인증' };
    if (id === 'aqr_transfer') return { title: '무료 계좌송금', detail: 'PG 비율 수수료 없음 · 은행송금 · 자동 입금 확인' };
    return { title: id, detail: '등록된 결제사' };
  }

  function renderProviderChooser() {
    els.providerOptions.innerHTML = '';
    els.providerHint.textContent = '사용할 수 있는 결제수단만 표시됩니다.';

    for (const option of providerOptions) {
      const meta = providerMeta(option.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-option';
      button.dataset.provider = option.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', option.id === activeProvider ? 'true' : 'false');
      button.innerHTML = `
        <span class="provider-radio" aria-hidden="true"></span>
        <span class="provider-option-copy">
          <strong class="provider-wordmark provider-wordmark-${escapeHTML(option.id)}">${escapeHTML(meta.title)}</strong>
          <small>${escapeHTML(meta.detail)}</small>
        </span>
        <span class="provider-mode ${escapeHTML(option.mode)}">${escapeHTML(option.mode === 'live' ? 'LIVE' : 'TEST')}</span>`;
      button.addEventListener('click', () => selectProvider(option.id));
      els.providerOptions.appendChild(button);
    }
    show(els.providerChooser);
  }

  function updateProviderSelection() {
    els.providerOptions.querySelectorAll('[data-provider]').forEach((button) => {
      const selected = button.dataset.provider === activeProvider;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
  }

  async function prepare(name, input = null) {
    const opts = { method:'POST' };
    if (input) { opts.headers = { 'Content-Type':'application/json' }; opts.body = JSON.stringify(input); }
    const r = await api(`/api/public/sessions/${encodeURIComponent(sessionId)}/providers/${encodeURIComponent(name)}/prepare`, opts);
    let payload = {};
    try { payload = await r.json(); } catch {}
    if (!r.ok) throw new Error(payload.error || `결제 준비에 실패했습니다. (${r.status})`);
    return payload;
  }

  async function mountToss(s) {
    hide(els.hostedCheckout); hide(els.bankCheckout); hide(els.aqrCheckout); show(els.tossCheckout); clearError();
    $('#toss-payment-method').innerHTML = '';
    $('#toss-agreement').innerHTML = '';
    els.tossPayButton.disabled = true;

    const prepared = await prepare('toss');
    if (prepared.mode !== 'toss_widget') throw new Error('TossPayments 주문서형 결제 설정을 확인해 주세요.');
    if (!window.TossPayments) throw new Error('TossPayments 공식 SDK를 불러오지 못했습니다.');

    const tossPayments = TossPayments(prepared.client_key);
    tossWidgets = tossPayments.widgets({ customerKey: TossPayments.ANONYMOUS });
    await tossWidgets.setAmount({ currency: prepared.payload.currency, value: prepared.payload.amount });
    await Promise.all([
      tossWidgets.renderPaymentMethods({ selector: '#toss-payment-method', variantKey: prepared.payload.paymentVariantKey || 'DEFAULT' }),
      tossWidgets.renderAgreement({ selector: '#toss-agreement', variantKey: prepared.payload.agreementVariantKey || 'AGREEMENT' }),
    ]);

    els.tossPayButton.disabled = false;
    els.tossPayButton.onclick = async () => {
      if (busy || !tossWidgets) return;
      busy = true; clearError(); els.tossPayButton.disabled = true; els.tossPayButton.setAttribute('aria-busy', 'true');
      try {
        await tossWidgets.requestPayment({
          orderId: prepared.payload.orderId, orderName: prepared.payload.orderName,
          successUrl: prepared.payload.successUrl, failUrl: prepared.payload.failUrl,
          customerName: prepared.payload.customerName || undefined,
        });
      } catch (error) {
        showError(paymentErrorMessage(String(error?.code || '')));
        els.tossPayButton.disabled = false; els.tossPayButton.removeAttribute('aria-busy'); busy = false;
      }
    };
  }

  const banks = [
    ['004','국민은행'],['088','신한은행'],['020','우리은행'],['081','하나은행'],
    ['011','농협은행'],['003','기업은행'],['090','카카오뱅크'],['092','토스뱅크'],
    ['089','케이뱅크'],['023','SC제일은행'],['002','산업은행'],['007','수협은행'],
    ['031','iM뱅크'],['032','부산은행'],['034','광주은행'],['039','경남은행'],
    ['037','전북은행'],['035','제주은행'],['045','새마을금고'],['048','신협'],['071','우체국']
  ];

  function mountBank() {
    hide(els.tossCheckout); hide(els.hostedCheckout); hide(els.aqrCheckout); show(els.bankCheckout); clearError();
    els.bankOptions.replaceChildren();
    els.bankPayButton.disabled = true;
    els.bankPayButton.textContent = '은행을 선택하세요';
    let selected = '';
    for (const [code, label] of banks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bank-option';
      button.setAttribute('role','radio');
      button.setAttribute('aria-checked','false');
      button.textContent = label;
      button.onclick = () => {
        selected = code;
        els.bankOptions.querySelectorAll('.bank-option').forEach(el => {
          const active = el === button;
          el.classList.toggle('active', active);
          el.setAttribute('aria-checked', String(active));
        });
        els.bankPayButton.disabled = false;
        els.bankPayButton.textContent = `${label} 계좌 인증 및 이체`;
      };
      els.bankOptions.appendChild(button);
    }
    els.bankPayButton.onclick = async () => {
      if (busy || !selected) return;
      busy = true; clearError();
      els.bankPayButton.disabled = true;
      els.bankPayButton.setAttribute('aria-busy','true');
      try {
        const prepared = await prepare('bank_transfer', {bank_code: selected});
        if (prepared.mode !== 'redirect' || !prepared.url) throw new Error('은행 인증을 시작하지 못했습니다.');
        const auth = new URL(prepared.url);
        if (auth.protocol !== 'https:' || auth.hostname !== 'openapi.openbanking.or.kr') {
          throw new Error('공식 오픈뱅킹 인증 주소가 아닙니다.');
        }
        location.assign(auth.href);
      } catch(error) {
        showError(error.message || '은행 인증을 시작하지 못했습니다.');
        busy = false;
        els.bankPayButton.disabled = false;
        els.bankPayButton.removeAttribute('aria-busy');
      }
    };
  }


  let aqrScriptPromise = null;
  function loadAQRScript() {
    if (window.AQRWidget) return Promise.resolve();
    if (aqrScriptPromise) return aqrScriptPromise;
    aqrScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://aq.gy/widget';
      script.onload = () => window.AQRWidget ? resolve() : reject(new Error('AQR 위젯을 불러오지 못했습니다.'));
      script.onerror = () => reject(new Error('AQR 송금 위젯 연결에 실패했습니다.'));
      document.head.appendChild(script);
    });
    return aqrScriptPromise;
  }

  function stopDepositPolling() {
    if (depositPollTimer) clearInterval(depositPollTimer);
    depositPollTimer = null;
  }

  async function checkDepositStatus() {
    if (document.hidden || activeProvider !== 'aqr_transfer') return;
    try {
      const r = await api(`/api/public/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const current = await r.json();
      if (current.status === 'PAID') {
        stopDepositPolling();
        hide(els.aqrCheckout); hide(els.providerChooser);
        show(els.paidState);
        clearError();
        return;
      }
      if (current.status === 'FAILED' || current.status === 'CANCELLED') {
        stopDepositPolling();
        showError('입금이 확인되지 않았습니다. 주문 상태를 확인해 주세요.');
      }
    } catch (_) { /* transient error: retry, never mark paid */ }
  }

  async function startAQRTransfer() {
    if (busy) return;
    busy = true; clearError();
    els.aqrStartButton.disabled = true;
    els.aqrStartButton.setAttribute('aria-busy', 'true');
    try {
      await loadAQRScript();
      const prepared = await prepare('aqr_transfer');
      if (prepared.mode !== 'aqr_widget' || !/^[A-Za-z0-9_-]{1,80}$/.test(String(prepared.token || ''))
          || Number(prepared.amount) !== Number(session.amount)) {
        throw new Error('송금 주문정보를 확인할 수 없습니다.');
      }
      els.aqrWidgetContainer.classList.remove('hidden');
      $('#aqr-widget-area').replaceChildren();
      new AQRWidget().renderAQRWidget({
        token: prepared.token, layer_id: 'aqr-widget-area',
        profile: false, libbutton: false, bgcolor: '#f8f9fa',
        button_text: '은행 송금하기', amount: Number(prepared.amount),
      });
      hide(els.aqrStartButton); show(els.aqrWaiting);
      // A confirmed QuickBank webhook, not this UI action, is the only
      // source allowed to change the PayHub payment status to PAID.
      stopDepositPolling();
      depositPollTimer = setInterval(checkDepositStatus, 2500);
      await checkDepositStatus();
      hide(els.providerChooser);
    } catch (error) {
      showError(error.message || '계좌송금 주문을 준비하지 못했습니다.');
      els.aqrStartButton.disabled = false;
    } finally {
      els.aqrStartButton.removeAttribute('aria-busy');
      busy = false;
    }
  }

  function mountAQR() {
    hide(els.hostedCheckout); hide(els.bankCheckout); hide(els.tossCheckout);
    show(els.aqrCheckout); clearError();
    hide(els.aqrWidgetContainer); hide(els.aqrWaiting);
    show(els.aqrStartButton);
    els.aqrStartButton.disabled = false;
    els.aqrStartButton.onclick = startAQRTransfer;
    if (session.status === 'PROCESSING' && session.provider === 'aqr_transfer') {
      // Restore the same order without re-registering a QuickBank intent.
      startAQRTransfer();
    }
  }

  function hostedProviderCopy(name, s) {
    if (name === 'stripe') return {
      name: 'Stripe Checkout', title: s.country === 'KR' ? '해외 카드로 결제' : '카드 · 현지 결제수단',
      copy: 'Stripe의 보안 Checkout으로 이동해 사용 가능한 카드 및 현지 결제수단을 선택합니다.', button: 'Stripe Checkout으로 이동',
    };
    if (name === 'paypal') return {
      name: 'PayPal', title: 'PayPal로 결제', copy: 'PayPal 공식 화면에서 승인을 완료하면 PayHub가 최종 결제 여부를 확인합니다.', button: 'PayPal로 계속하기',
    };
    return { name, title: '결제 계속하기', copy: '결제사 화면에서 결제를 완료합니다.', button: '계속' };
  }

  function showHostedProvider(name, s) {
    hide(els.tossCheckout); hide(els.bankCheckout); hide(els.aqrCheckout); show(els.hostedCheckout); clearError();
    const copy = hostedProviderCopy(name, s);
    els.hostedProviderName.textContent = copy.name;
    $('#hostedCheckoutTitle').textContent = copy.title;
    els.hostedCheckoutCopy.textContent = copy.copy;
    els.hostedPayButton.textContent = copy.button;
    els.hostedPayButton.onclick = () => startRedirectProvider(name);
  }

  async function startRedirectProvider(name) {
    if (busy) return;
    busy = true; clearError(); els.hostedPayButton.disabled = true; els.hostedPayButton.setAttribute('aria-busy', 'true');
    try {
      const prepared = await prepare(name);
      if (prepared.mode !== 'redirect' || !prepared.url) throw new Error('결제사 이동 URL을 받지 못했습니다.');
      location.assign(prepared.url);
    } catch (error) {
      showError(error.message || String(error));
      els.hostedPayButton.disabled = false; els.hostedPayButton.removeAttribute('aria-busy'); busy = false;
    }
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function tossSetupMessage(error) {
    const code = String(error?.code || '');
    if (code === 'NOT_SUPPORTED_API_INDIVIDUAL_KEY') return 'TossPayments 주문서형 결제 연동 키(Client Key: gck 계열)가 필요합니다. PayHub 프로젝트의 TossPayments 키를 확인해 주세요.';
    if (code === 'INVALID_CLIENT_KEY') return 'TossPayments Client Key가 올바르지 않습니다. PayHub 프로젝트 설정을 확인해 주세요.';
    if (code === 'NOT_REGISTERED_PAYMENT_WIDGET') return 'TossPayments 상점관리자에서 이 연동 키에 사용할 결제 UI를 먼저 추가해 주세요.';
    return error?.message || 'TossPayments 결제 UI를 불러오지 못했습니다.';
  }

  async function selectProvider(name) {
    if (busy || !providerOptions.some((p) => p.id === name)) return;
    activeProvider = name; stopDepositPolling(); updateProviderSelection(); clearError(); tossWidgets = null;
    if (name === 'aqr_transfer') {
      hide(els.loadingState); mountAQR(); return;
    }
    if (name === 'bank_transfer') {
      hide(els.loadingState); mountBank(); return;
    }
    if (name === 'toss') {
      show(els.loadingState); hide(els.hostedCheckout); hide(els.tossCheckout);
      try { await mountToss(session); }
      catch (error) { hide(els.tossCheckout); showError(tossSetupMessage(error)); }
      finally { hide(els.loadingState); }
      return;
    }
    hide(els.loadingState); showHostedProvider(name, session);
  }

  function preferredProvider(s) {
    const ids = providerOptions.map((p) => p.id);
    if (s.status === 'PROCESSING' && s.provider === 'aqr_transfer' && ids.includes('aqr_transfer')) return 'aqr_transfer';
    if (s.country === 'KR' && s.currency === 'KRW' && ids.includes('aqr_transfer')) return 'aqr_transfer';
    if (s.country === 'KR' && s.currency === 'KRW' && ids.includes('toss')) return 'toss';
    if (ids.includes('stripe')) return 'stripe';
    if (ids.includes('paypal')) return 'paypal';
    return ids[0] || '';
  }

  async function load() {
    setBuildVersion();
    if (!API_BASE) throw new Error('PayHub API 설정이 없습니다.');
    if (!sessionId) throw new Error('결제 세션이 없습니다.');

    const r = await api(`/api/public/sessions/${encodeURIComponent(sessionId)}`);
    if (!r.ok) { let body = ''; try { body = await r.text(); } catch {} throw new Error(body || '결제 세션을 불러오지 못했습니다.'); }

    session = await r.json(); renderSummary(session); renderReturnState();
    if (session.status === 'PAID') { hide(els.loadingState); hide(els.providerChooser); show(els.paidState); return; }

    providerOptions = normalizeProviderOptions(session);
    if (!providerOptions.length) { hide(els.loadingState); showError('현재 사용할 수 있는 결제수단이 없습니다. 판매처에 문의해 주세요.'); return; }

    activeProvider = preferredProvider(session);
    const singleJournalTossTest = journalCheckout && providerOptions.length === 1
      && providerOptions[0].id === 'toss' && providerOptions[0].mode === 'test';
    if (singleJournalTossTest) {
      hide(els.providerChooser);
      $('#journalTestNotice').hidden = false;
    } else {
      // Provider choice remains available when there is more than one eligible method.
      // Never silently hide a live provider or bypass its official payment widget.
      renderProviderChooser(); updateProviderSelection();
    }
    await selectProvider(activeProvider);
  }

  load().catch((error) => {
    hide(els.loadingState); hide(els.providerChooser);
    els.title.textContent = '결제를 열 수 없습니다';
    els.summaryDescription.textContent = '결제 정보를 다시 확인해 주세요.';
    showError(error.message || String(error));
  });
})();
