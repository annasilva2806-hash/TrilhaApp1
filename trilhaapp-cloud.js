(function(){
  if(typeof window === 'undefined' || typeof localStorage === 'undefined') return;

  var CONFIG_KEY = 'sos_cloudConfig';
  var META_KEY = 'sos_cloudMeta';
  var SNAPSHOT_TABLE = 'trilhaapp_snapshots';
  var SAVE_KEYS = [
    'discs','cycle','sessions','topics','streak','daytime','questoes','topicStats',
    'reviews','examConfig','cycleProfiles','activeCycleProfileId','smartPrefs','smartIgnore'
  ];
  var TrilhaCloud = window.TrilhaCloud || {};
  var client = null;
  var saveTimer = null;
  var isApplyingSnapshot = false;

  function readConfig(){
    try{
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    }catch(e){
      return {};
    }
  }

  function saveConfig(config){
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config || {}));
  }

  function isConfigured(){
    var config = readConfig();
    return !!(config.url && config.anonKey && window.supabase && window.supabase.createClient);
  }

  function getClient(){
    var config = readConfig();
    if(!config.url || !config.anonKey || !window.supabase || !window.supabase.createClient) return null;
    if(client && client.__url === config.url && client.__anonKey === config.anonKey) return client;
    client = window.supabase.createClient(config.url, config.anonKey);
    client.__url = config.url;
    client.__anonKey = config.anonKey;
    return client;
  }

  function readMeta(){
    try{
      return JSON.parse(localStorage.getItem(META_KEY) || '{}');
    }catch(e){
      return {};
    }
  }

  function saveMeta(meta){
    localStorage.setItem(META_KEY, JSON.stringify(meta || {}));
  }

  function currentSnapshot(){
    var snapshot = {};
    SAVE_KEYS.forEach(function(key){
      if(typeof DB !== 'undefined' && DB && typeof DB.get === 'function'){
        snapshot[key] = DB.get(key, null);
      }else{
        try{
          snapshot[key] = JSON.parse(localStorage.getItem('sos_' + key) || 'null');
        }catch(e){
          snapshot[key] = null;
        }
      }
    });
    return snapshot;
  }

  function persistSnapshotLocally(snapshot){
    SAVE_KEYS.forEach(function(key){
      if(snapshot[key] === undefined) return;
      localStorage.setItem('sos_' + key, JSON.stringify(snapshot[key]));
    });
  }

  function patchPersistence(){
    if(!window.DB || DB.__cloudWrapped) return;
    var baseSet = DB.set.bind(DB);
    DB.set = function(key, value){
      baseSet(key, value);
      queueUpload('db:' + key);
    };
    DB.__cloudWrapped = true;
  }

  function queueUpload(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(syncUp, 900);
  }

  async function syncUp(){
    if(isApplyingSnapshot || !isConfigured()) return;
    var supabase = getClient();
    if(!supabase) return;
    var sessionResult = await supabase.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
    if(!session || !session.user) return;
    var payload = {
      user_id: session.user.id,
      profile_name: (session.user.user_metadata && session.user.user_metadata.name) || session.user.email || 'concurseiro(a)',
      snapshot: currentSnapshot(),
      updated_at: new Date().toISOString()
    };
    var result = await supabase.from(SNAPSHOT_TABLE).upsert(payload);
    if(result && result.error){
      console.warn('TrilhaCloud syncUp error', result.error);
      return;
    }
    saveMeta({
      userId: session.user.id,
      updatedAt: payload.updated_at
    });
  }

  async function syncDown(){
    if(!isConfigured()) return { ok:true };
    var supabase = getClient();
    if(!supabase) return { ok:false, error:'Supabase nao configurado.' };
    var sessionResult = await supabase.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
    if(!session || !session.user) return { ok:true };

    var query = await supabase
      .from(SNAPSHOT_TABLE)
      .select('snapshot, updated_at')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if(query.error){
      return {
        ok:false,
        error:'Nao foi possivel ler os dados na nuvem. Verifique se a tabela e as permissoes foram criadas no Supabase.'
      };
    }

    if(!query.data || !query.data.snapshot) return { ok:true };

    var meta = readMeta();
    if(meta.userId === session.user.id && meta.updatedAt === query.data.updated_at){
      return { ok:true };
    }

    isApplyingSnapshot = true;
    persistSnapshotLocally(query.data.snapshot);
    saveMeta({ userId: session.user.id, updatedAt: query.data.updated_at });
    isApplyingSnapshot = false;
    return { ok:true, reloaded:true };
  }

  function ensurePanelHost(){
    var host = document.getElementById('cloud-auth-panel');
    if(host) return host;
    var note = document.querySelector('.auth-note');
    if(!note || !note.parentNode) return null;
    host = document.createElement('div');
    host.id = 'cloud-auth-panel';
    note.parentNode.insertBefore(host, note);
    return host;
  }

  function injectStyles(){
    if(document.getElementById('cloud-auth-style')) return;
    var style = document.createElement('style');
    style.id = 'cloud-auth-style';
    style.textContent = [
      '.cloud-box{margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.7)}',
      '.cloud-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}',
      '.cloud-title{font-size:.78rem;font-weight:700;color:var(--blue)}',
      '.cloud-status{font-size:.7rem;padding:4px 8px;border-radius:999px;background:#eef6fb;color:var(--blue)}',
      '.cloud-copy{font-size:.72rem;color:var(--text3);line-height:1.5;margin-bottom:8px}',
      '.cloud-grid{display:grid;gap:8px;margin-top:8px}',
      '.cloud-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}',
      '.cloud-sql{margin-top:10px;padding:10px;border-radius:12px;background:var(--bg3);border:1px solid var(--border);font-size:.68rem;line-height:1.5;color:var(--text2);white-space:pre-wrap}',
      '.cloud-help{font-size:.68rem;color:var(--text3);margin-top:8px;line-height:1.5}'
    ].join('');
    document.head.appendChild(style);
  }

  function sqlSetupText(){
    return [
      'create table if not exists public.trilhaapp_snapshots (',
      '  user_id uuid primary key references auth.users(id) on delete cascade,',
      '  profile_name text,',
      '  snapshot jsonb not null default \'{}\'::jsonb,',
      '  updated_at timestamptz not null default timezone(\'utc\', now())',
      ');',
      '',
      'alter table public.trilhaapp_snapshots enable row level security;',
      '',
      'create policy "users_manage_own_snapshot"',
      'on public.trilhaapp_snapshots',
      'for all',
      'using (auth.uid() = user_id)',
      'with check (auth.uid() = user_id);'
    ].join('\n');
  }

  function renderPanel(){
    var host = ensurePanelHost();
    if(!host) return;
    injectStyles();
    var config = readConfig();
    host.innerHTML =
      '<div class="cloud-box">' +
        '<div class="cloud-head"><div class="cloud-title">Sincronizacao entre dispositivos</div><span class="cloud-status">' + (isConfigured() ? 'Nuvem ativa' : 'Configuracao pendente') + '</span></div>' +
        '<div class="cloud-copy">Configure o Supabase uma vez para cada usuario acessar os mesmos dados no celular, notebook ou outro navegador.</div>' +
        '<details ' + (isConfigured() ? '' : 'open') + '>' +
          '<summary style="cursor:pointer;font-size:.74rem;font-weight:700;color:var(--text2)">Configurar nuvem</summary>' +
          '<div class="cloud-grid">' +
            '<div class="fgroup"><label class="flbl">Project URL</label><input class="finput" id="cloud-url" type="text" placeholder="https://xxxx.supabase.co" value="' + (config.url || '') + '"/></div>' +
            '<div class="fgroup"><label class="flbl">Anon key</label><input class="finput" id="cloud-anon" type="password" placeholder="Cole a anon key do Supabase" value="' + (config.anonKey || '') + '"/></div>' +
          '</div>' +
          '<div class="cloud-actions">' +
            '<button class="btn btn-secondary" type="button" onclick="TrilhaCloud.saveConfigFromInputs()">Salvar configuracao</button>' +
            '<button class="btn btn-ghost" type="button" onclick="TrilhaCloud.copySqlSetup()">Copiar SQL</button>' +
          '</div>' +
          '<div class="cloud-help">No Supabase, crie a tabela e a politica acima no SQL Editor. Depois salve a URL e a anon key aqui.</div>' +
          '<div class="cloud-sql" id="cloud-sql-box">' + sqlSetupText() + '</div>' +
        '</details>' +
      '</div>';

    var authCopy = document.querySelector('.auth-copy');
    if(authCopy){
      authCopy.textContent = isConfigured()
        ? 'Entre com seu e-mail e senha para carregar os dados da nuvem neste dispositivo.'
        : 'Voce pode usar acesso local neste navegador ou configurar sincronizacao em nuvem para entrar em varios dispositivos com os mesmos dados.';
    }
  }

  async function getSessionState(){
    renderPanel();
    if(!isConfigured()) return { mode:'local' };
    var supabase = getClient();
    if(!supabase) return { mode:'local' };
    var sessionResult = await supabase.auth.getSession();
    var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
    if(!session || !session.user) return { mode:'local' };

    var syncResult = await syncDown();
    if(syncResult && syncResult.reloaded){
      location.reload();
      return { mode:'cloud' };
    }

    return {
      mode: 'cloud',
      name: (session.user.user_metadata && session.user.user_metadata.name) || session.user.email || 'concurseiro(a)'
    };
  }

  async function submitAuth(input){
    if(!isConfigured()){
      return { ok:false, error:'Configure a nuvem primeiro ou continue no modo local.' };
    }
    var supabase = getClient();
    if(!supabase) return { ok:false, error:'Cliente Supabase indisponivel.' };
    if(!input.email || !input.password){
      return { ok:false, error:'Preencha e-mail e senha.' };
    }

    var result;
    if(input.mode === 'register'){
      if(!input.name){
        return { ok:false, error:'Informe seu nome para criar a conta.' };
      }
      result = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: { data: { name: input.name } }
      });
      if(result.error){
        return { ok:false, error: result.error.message };
      }
      if(!result.data || !result.data.session){
        return { ok:false, error:'Cadastro criado. Se seu projeto exigir confirmacao por e-mail, confirme o e-mail e depois faca login.' };
      }
    }else{
      result = await supabase.auth.signInWithPassword({
        email: input.email,
        password: input.password
      });
      if(result.error){
        return { ok:false, error: result.error.message };
      }
    }

    var syncResult = await syncDown();
    if(syncResult && syncResult.ok === false){
      return { ok:false, error: syncResult.error };
    }
    if(syncResult && syncResult.reloaded){
      return { ok:true, name: input.name || input.email };
    }

    await syncUp();
    return {
      ok:true,
      name: (result.data.user && result.data.user.user_metadata && result.data.user.user_metadata.name) || input.name || input.email
    };
  }

  async function logout(){
    if(!isConfigured()) return;
    var supabase = getClient();
    if(!supabase) return;
    await supabase.auth.signOut();
  }

  function saveConfigFromInputs(){
    var url = (document.getElementById('cloud-url') || {}).value || '';
    var anonKey = (document.getElementById('cloud-anon') || {}).value || '';
    saveConfig({ url: url.trim(), anonKey: anonKey.trim() });
    client = null;
    renderPanel();
    alert(anonKey && url ? 'Configuracao da nuvem salva.' : 'Configuracao removida. O app volta ao modo local.');
  }

  function copySqlSetup(){
    var text = sqlSetupText();
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text);
      alert('SQL copiado. Cole no SQL Editor do Supabase.');
      return;
    }
    alert('Copie manualmente o SQL exibido no painel.');
  }

  TrilhaCloud.isConfigured = isConfigured;
  TrilhaCloud.getSessionState = getSessionState;
  TrilhaCloud.submitAuth = submitAuth;
  TrilhaCloud.logout = logout;
  TrilhaCloud.mountAuthUI = renderPanel;
  TrilhaCloud.saveConfigFromInputs = saveConfigFromInputs;
  TrilhaCloud.copySqlSetup = copySqlSetup;
  TrilhaCloud.syncNow = syncUp;
  window.TrilhaCloud = TrilhaCloud;

  patchPersistence();
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', renderPanel);
  }else{
    renderPanel();
  }
})();
