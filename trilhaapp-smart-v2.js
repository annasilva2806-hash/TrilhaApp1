(function(){
  // Camada modular incremental:
  // - estado e preferencias locais
  // - motor de recomendacao
  // - fluxo automatico de estudo
  // - UI da tela Hoje
  // - insights e tendencias de desempenho
  if(typeof window === 'undefined' || typeof DB === 'undefined' || typeof discs === 'undefined') return;

  var SMART_PREFS_KEY = 'smartPrefs';
  var SMART_IGNORE_KEY = 'smartIgnore';
  var SmartStudy = {};

  function getPrefs(){
    return DB.get(SMART_PREFS_KEY, { topicBoosts: {} }) || { topicBoosts: {} };
  }

  function savePrefs(prefs){
    DB.set(SMART_PREFS_KEY, prefs);
  }

  function getIgnoreMap(){
    return DB.get(SMART_IGNORE_KEY, {}) || {};
  }

  function saveIgnoreMap(map){
    DB.set(SMART_IGNORE_KEY, map);
  }

  function daysSince(timestamp){
    if(!timestamp) return 999;
    return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  }

  function getDiscReviews(discId){
    return DB.get('reviews', []).filter(function(review){
      return !review.done && review.discId === discId;
    });
  }

  function getReviewWeight(discId){
    var reviews = getDiscReviews(discId);
    if(!reviews.length) return 0;
    var overdue = reviews.some(function(review){ return review.dueAt <= Date.now(); });
    return overdue ? 1 : 0.6;
  }

  function getTopicBoost(discId, topicId){
    var prefs = getPrefs();
    var key = discId + '::' + (topicId || '__general__');
    return prefs.topicBoosts[key] || 0;
  }

  function updateTopicBoost(discId, topicId, delta){
    var prefs = getPrefs();
    var key = discId + '::' + (topicId || '__general__');
    var current = prefs.topicBoosts[key] || 0;
    prefs.topicBoosts[key] = Math.max(-20, Math.min(20, current + delta));
    savePrefs(prefs);
  }

  function getRecentQuestionBuckets(rangeStart, rangeEnd){
    return questoes.filter(function(item){
      return item.data >= rangeStart && item.data <= rangeEnd;
    });
  }

  function getWeeklyPerformanceSummary(){
    var end = new Date(today() + 'T12:00:00');
    var currentStart = new Date(end);
    currentStart.setDate(currentStart.getDate() - 6);
    var prevEnd = new Date(currentStart);
    prevEnd.setDate(prevEnd.getDate() - 1);
    var prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - 6);

    var currentItems = getRecentQuestionBuckets(currentStart.toISOString().slice(0,10), end.toISOString().slice(0,10));
    var previousItems = getRecentQuestionBuckets(prevStart.toISOString().slice(0,10), prevEnd.toISOString().slice(0,10));

    function average(items){
      var total = items.reduce(function(sum, item){ return sum + (item.percentual || 0); }, 0);
      return items.length ? Math.round(total / items.length) : null;
    }

    var currentAvg = average(currentItems);
    var previousAvg = average(previousItems);
    var diff = currentAvg !== null && previousAvg !== null ? currentAvg - previousAvg : null;

    return {
      currentAvg: currentAvg,
      previousAvg: previousAvg,
      diff: diff,
      label: diff === null ? 'sem base suficiente' : (diff >= 0 ? 'subindo' : 'caindo')
    };
  }

  function getDisciplineInsights(){
    var buckets = {};
    questoes.forEach(function(item){
      if(!buckets[item.discId]) buckets[item.discId] = [];
      buckets[item.discId].push(item);
    });

    return Object.keys(buckets).map(function(discId){
      var items = buckets[discId].sort(function(a, b){ return a.data.localeCompare(b.data); });
      var recent = items.slice(-3);
      var previous = items.slice(-6, -3);
      var recentAvg = recent.length ? Math.round(recent.reduce(function(sum, item){ return sum + item.percentual; }, 0) / recent.length) : null;
      var previousAvg = previous.length ? Math.round(previous.reduce(function(sum, item){ return sum + item.percentual; }, 0) / previous.length) : null;
      return {
        discId: discId,
        discName: items[0] ? items[0].discName : '',
        recentAvg: recentAvg,
        previousAvg: previousAvg,
        delta: recentAvg !== null && previousAvg !== null ? recentAvg - previousAvg : null
      };
    }).filter(function(item){ return item.recentAvg !== null; }).sort(function(a, b){
      return (a.delta || 0) - (b.delta || 0);
    });
  }

  function buildCandidates(){
    return discs.reduce(function(list, disc){
      var discTopics = (topics[disc.id] || []).slice();
      if(!discTopics.length){
        discTopics = [{ id: '', name: 'Sessao geral', done: false, lastStudiedAt: disc.lastStudied || null }];
      }

      discTopics.forEach(function(topic){
        var stats = topic.id ? topicPerf(disc.id, topic.id) : { percentual: null, total: 0, acertos: 0, sessoes: 0, lastAt: disc.lastStudied || null };
        var lastSeen = topic.lastStudiedAt || stats.lastAt || disc.lastStudied || null;
        var idleDays = daysSince(lastSeen);
        var perfScore = stats.percentual === null ? 32 : Math.round((100 - stats.percentual) * 0.55);
        var idleScore = Math.min(30, idleDays * 3);
        var reviewScore = Math.round(getReviewWeight(disc.id) * 20);
        var manualScore = getTopicBoost(disc.id, topic.id);
        var pendingPenalty = topic.done ? -8 : 6;
        var totalScore = perfScore + idleScore + reviewScore + manualScore + pendingPenalty;
        var reasons = [];

        if(stats.percentual !== null){
          reasons.push(stats.percentual + '% de acerto');
        }else{
          reasons.push('sem questoes registradas');
        }
        reasons.push(idleDays >= 999 ? 'ainda nao estudado' : idleDays + ' dia(s) sem estudar');
        if(reviewScore) reasons.push(getDiscReviews(disc.id).length + ' revisao(oes) pendente(s)');
        if(manualScore > 0) reasons.push('prioridade ajustada manualmente');
        if(manualScore < 0) reasons.push('prioridade reduzida manualmente');

        list.push({
          discId: disc.id,
          discName: disc.name,
          topicId: topic.id || '',
          topicName: topic.name || 'Sessao geral',
          score: totalScore,
          idleDays: idleDays,
          accuracy: stats.percentual,
          reasons: reasons,
          reviewCount: getDiscReviews(disc.id).length
        });
      });
      return list;
    }, []);
  }

  function recommendationIgnored(candidate){
    var ignoreMap = getIgnoreMap();
    return ignoreMap[today()] === (candidate.discId + '::' + candidate.topicId);
  }

  SmartStudy.getRecommendation = function(){
    var candidates = buildCandidates().sort(function(a, b){ return b.score - a.score; });
    var selected = candidates.find(function(candidate){ return !recommendationIgnored(candidate); }) || candidates[0] || null;
    if(!selected) return null;
    var reason = 'Foque em ' + selected.discName + ' - ' + selected.topicName + ' (' + selected.reasons.slice(0, 3).join(' e ') + ')';
    selected.reason = reason;
    selected.priorityLabel = selected.score >= 70 ? 'Alta' : selected.score >= 45 ? 'Media' : 'Equilibrada';
    return selected;
  };

  SmartStudy.ignoreRecommendation = function(){
    var recommendation = SmartStudy.getRecommendation();
    if(!recommendation) return;
    var ignoreMap = getIgnoreMap();
    ignoreMap[today()] = recommendation.discId + '::' + recommendation.topicId;
    saveIgnoreMap(ignoreMap);
    renderHome();
  };

  SmartStudy.adjustPriority = function(direction){
    var recommendation = SmartStudy.getRecommendation();
    if(!recommendation) return;
    updateTopicBoost(recommendation.discId, recommendation.topicId, direction === 'up' ? 5 : -5);
    renderHome();
  };

  SmartStudy.activeContext = null;

  window.startSmartStudy = function(){
    var recommendation = SmartStudy.getRecommendation();
    if(!recommendation){
      alert('Cadastre disciplinas e topicos para gerar uma recomendacao inteligente.');
      return;
    }
    SmartStudy.activeContext = {
      discId: recommendation.discId,
      discName: recommendation.discName,
      topicId: recommendation.topicId,
      topicName: recommendation.topicName,
      startedAt: Date.now()
    };
    startStudy(recommendation.discId);
  };

  function injectSmartStyles(){
    if(document.getElementById('smart-study-style')) return;
    var style = document.createElement('style');
    style.id = 'smart-study-style';
    style.textContent = [
      ".today-shell{display:grid;gap:16px}",
      ".today-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.76fr);gap:16px;align-items:start}",
      ".today-main{padding:30px;position:relative;overflow:hidden;background:linear-gradient(135deg,#f4efff 0%,#ede5ff 58%,#fff6dc 100%);color:#261f48;border:1px solid rgba(91,63,209,.12);border-radius:26px;box-shadow:0 28px 70px rgba(91,63,209,.12)}",
      ".today-main:before{content:'';position:absolute;inset:-40px -30px auto auto;width:210px;height:210px;border-radius:999px;background:radial-gradient(circle,rgba(139,92,246,.16) 0%,rgba(139,92,246,.02) 66%,transparent 67%)}",
      ".today-main:after{content:'';position:absolute;left:-30px;bottom:-46px;width:160px;height:160px;border-radius:40px;background:rgba(255,202,77,.22);filter:blur(2px);transform:rotate(24deg)}",
      ".today-kicker{position:relative;z-index:1;display:inline-flex;align-items:center;padding:8px 12px;border-radius:999px;background:rgba(91,63,209,.10);backdrop-filter:blur(10px);font-size:.69rem;text-transform:uppercase;letter-spacing:.1em;color:#5b3fd1;font-weight:800;margin-bottom:14px}",
      ".today-title{position:relative;z-index:1;font-size:1.78rem;line-height:1.06;font-weight:800;max-width:520px;margin-bottom:10px;letter-spacing:-.035em;color:#241c46}",
      ".today-copy{position:relative;z-index:1;font-size:.84rem;color:#5f567f;line-height:1.68;max-width:560px}",
      ".today-meta{position:relative;z-index:1;display:flex;flex-wrap:wrap;gap:9px;margin:16px 0 18px}",
      ".today-badge{padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.72);border:1px solid rgba(91,63,209,.10);font-size:.71rem;color:#3d3268;font-weight:700;backdrop-filter:blur(10px)}",
      ".today-actions{position:relative;z-index:1;display:flex;flex-wrap:wrap;gap:9px}",
      ".today-stack{display:grid;gap:12px}",
      ".today-mini{padding:18px 18px 16px;background:linear-gradient(180deg,rgba(255,255,255,.96) 0%,rgba(250,247,255,.94) 100%);backdrop-filter:blur(18px);border-radius:20px}",
      ".today-mini .card-title{margin-bottom:10px}",
      ".today-empty{padding:34px;text-align:center;color:var(--text3)}",
      ".trend-up{color:var(--green)}",
      ".trend-down{color:var(--red)}",
      ".smart-insights{display:grid;gap:10px;margin-top:12px}",
      ".smart-insight{padding:14px 14px;border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#faf7ff 100%);border:1px solid rgba(91,63,209,.08);font-size:.77rem;color:var(--text2);box-shadow:0 12px 24px rgba(91,63,209,.06)}",
      ".planner-layout{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(0,1.1fr);gap:16px}",
      ".planner-card{padding:18px 18px 16px;border-radius:22px}",
      ".planner-focus{background:linear-gradient(180deg,#ffffff 0%,#f8f3ff 100%)}",
      ".planner-focus-title{font-size:1.05rem;font-weight:800;color:var(--text);letter-spacing:-.02em}",
      ".planner-focus-copy{font-size:.78rem;color:var(--text3);line-height:1.65;margin-top:8px;max-width:340px}",
      ".planner-subjects{display:grid;gap:10px;margin-top:16px}",
      ".planner-subject{display:flex;align-items:center;gap:10px;padding:12px 12px;border-radius:16px;background:#fff;border:1px solid rgba(91,63,209,.08)}",
      ".planner-subject strong{font-size:.8rem;color:var(--text)}",
      ".planner-dot{width:10px;height:10px;border-radius:999px;flex-shrink:0}",
      ".planner-week{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px}",
      ".planner-day{padding:12px;border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#faf7ff 100%);border:1px solid rgba(91,63,209,.08)}",
      ".planner-day.is-today{background:linear-gradient(180deg,#f1eaff 0%,#fff8e3 100%);border-color:rgba(91,63,209,.16)}",
      ".planner-day-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:10px}",
      ".planner-day-label{font-size:.76rem;font-weight:800;color:var(--text)}",
      ".planner-day-time{font-size:.67rem;color:var(--text3)}",
      ".planner-chip-wrap{display:flex;flex-wrap:wrap;gap:6px}",
      ".planner-chip{display:inline-flex;align-items:center;padding:6px 9px;border-radius:999px;background:#f3edff;color:#55429a;font-size:.68rem;font-weight:700}",
      ".planner-chip-empty{background:#f4f5f7;color:var(--text3)}",
      ".today-main .btn-primary{background:linear-gradient(135deg,#5b3fd1 0%,#8b5cf6 100%);color:#fff;box-shadow:none}",
      ".today-main .btn-primary:hover{background:linear-gradient(135deg,#5136c1 0%,#7d4feb 100%)}",
      ".today-main .btn-secondary{background:rgba(91,63,209,.08);color:#4b37a8;border:1px solid rgba(91,63,209,.12)}",
      ".today-main .btn-secondary:hover{background:rgba(91,63,209,.14)}",
      ".today-main .btn-auth,.today-main .btn-ghost{background:rgba(255,255,255,.70);color:#43376e;border:1px solid rgba(91,63,209,.10)}",
      ".today-main .btn-auth:hover,.today-main .btn-ghost:hover{background:rgba(255,255,255,.92);color:#2f2455}",
      "@media (max-width: 960px){.today-grid,.planner-layout{grid-template-columns:1fr}.today-main{padding:22px}.today-title{font-size:1.65rem}.planner-week{grid-template-columns:1fr}}"
    ].join('');
    document.head.appendChild(style);
  }

  function getTodaySummary(){
    var dueCount = DB.get('reviews', []).filter(function(item){ return !item.done; }).length;
    var weeklySeconds = Object.keys(dayTime).filter(function(key){
      var limit = new Date(today() + 'T12:00:00');
      var day = new Date(key + 'T12:00:00');
      return (limit.getTime() - day.getTime()) / 86400000 <= 6;
    }).reduce(function(sum, key){ return sum + (dayTime[key] || 0); }, 0);
    var performance = getWeeklyPerformanceSummary();
    return {
      dueCount: dueCount,
      weeklySeconds: weeklySeconds,
      performance: performance
    };
  }

  function addDays(dateString, amount){
    var base = new Date(dateString + 'T12:00:00');
    base.setDate(base.getDate() + amount);
    return base.toISOString().slice(0, 10);
  }

  function getPlannerBaseDate(){
    var examConfig = DB.get('examConfig', { startDate:'', examDate:'' }) || { startDate:'', examDate:'' };
    var startDate = examConfig.startDate || today();
    var diff = Math.max(0, Math.floor((new Date(today() + 'T12:00:00') - new Date(startDate + 'T12:00:00')) / 86400000));
    return {
      startDate: startDate,
      offset: diff
    };
  }

  function formatPlannerLabel(dateString, offset){
    if(offset === 0) return 'Hoje';
    if(offset === 1) return 'Amanha';
    var date = new Date(dateString + 'T12:00:00');
    return date.toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'2-digit' }).replace('.', '');
  }

  function getPlannerDays(){
    if(!cycle.length || !discs.length) return [];

    var base = getPlannerBaseDate();
    var sessionsPerDay = Math.min(3, Math.max(1, Math.ceil(cycle.length / Math.max(1, Math.min(discs.length, 5)))));
    var days = [];

    for(var dayOffset = 0; dayOffset < 5; dayOffset++){
      var dateKey = addDays(today(), dayOffset);
      var cycleStart = ((base.offset + dayOffset) * sessionsPerDay) % cycle.length;
      var subjects = [];

      for(var slot = 0; slot < sessionsPerDay; slot++){
        var entry = cycle[(cycleStart + slot) % cycle.length];
        if(!entry) continue;
        var disc = discs.find(function(item){ return item.id === entry.discId; });
        if(!disc) continue;
        if(subjects.some(function(item){ return item.id === disc.id; })) continue;
        subjects.push({
          id: disc.id,
          name: disc.name,
          color: disc.color || 'var(--blue)'
        });
      }

      days.push({
        date: dateKey,
        label: formatPlannerLabel(dateKey, dayOffset),
        subjects: subjects,
        studiedSeconds: dayTime[dateKey] || 0,
        isToday: dayOffset === 0
      });
    }

    return days;
  }

  function renderPlannerSection(){
    var plannerDays = getPlannerDays();
    if(!plannerDays.length){
      return "<div class='card planner-card'><div class='card-title'>Planner da semana</div><div class='today-empty'>Gere um ciclo para o app mostrar automaticamente as materias do dia.</div></div>";
    }

    var todaySubjects = plannerDays[0].subjects.map(function(subject){
      return "<div class='planner-subject'>" +
        "<span class='planner-dot' style='background:" + subject.color + "'></span>" +
        "<strong>" + subject.name + "</strong>" +
      "</div>";
    }).join('');

    var weekHtml = plannerDays.map(function(day){
      var chips = day.subjects.map(function(subject){
        return "<span class='planner-chip'>" + subject.name + "</span>";
      }).join('');

      return "<div class='planner-day" + (day.isToday ? " is-today" : "") + "'>" +
        "<div class='planner-day-head'>" +
          "<span class='planner-day-label'>" + day.label + "</span>" +
          "<span class='planner-day-time'>" + (day.studiedSeconds ? fmtH(day.studiedSeconds) : "planejado") + "</span>" +
        "</div>" +
        "<div class='planner-chip-wrap'>" + (chips || "<span class='planner-chip planner-chip-empty'>Sem materia</span>") + "</div>" +
      "</div>";
    }).join('');

    return "<div class='planner-layout'>" +
      "<div class='card planner-card planner-focus'>" +
        "<div class='card-title'>Planner de hoje</div>" +
        "<div class='planner-focus-title'>" + plannerDays[0].label + " · " + new Date(plannerDays[0].date + 'T12:00:00').toLocaleDateString('pt-BR') + "</div>" +
        "<div class='planner-focus-copy'>Materias sugeridas pelo seu ciclo para facilitar o que estudar agora.</div>" +
        "<div class='planner-subjects'>" + (todaySubjects || "<div class='planner-subject'><strong>Sem materia definida</strong></div>") + "</div>" +
      "</div>" +
      "<div class='card planner-card'>" +
        "<div class='card-title'>Calendario da semana</div>" +
        "<div class='planner-week'>" + weekHtml + "</div>" +
      "</div>" +
    "</div>";
  }

  function renderTodayHome(){
    injectSmartStyles();
    TITLES.home = 'Hoje';
    var homeButton = document.querySelector(".nav-btn[onclick=\"go('home')\"]");
    if(homeButton) homeButton.innerHTML = "<span class='ico'>⌂</span>Hoje";

    var recommendation = SmartStudy.getRecommendation();
    var summary = getTodaySummary();
    var insights = getDisciplineInsights();
    var page = document.getElementById('page-home');
    if(!page) return;

    if(!discs.length){
      page.innerHTML = "<div class='card today-empty'>Comece adicionando um edital, disciplinas e topicos. A recomendacao inteligente aparece assim que houver base minima.</div>";
      return;
    }

    var trendLabel = summary.performance.diff === null ? "Sem comparacao ainda" : (summary.performance.diff >= 0 ? "Subiu " + summary.performance.diff + " ponto(s)" : "Caiu " + Math.abs(summary.performance.diff) + " ponto(s)");
    var insightHtml = insights.slice(0, 3).map(function(item){
      var trendClass = item.delta !== null && item.delta < 0 ? 'trend-down' : 'trend-up';
      var message = item.delta === null ? item.discName + ': base inicial de desempenho.' : item.discName + ': ' + (item.delta >= 0 ? 'evolucao de ' + item.delta + ' ponto(s).' : 'queda de ' + Math.abs(item.delta) + ' ponto(s).');
      return "<div class='smart-insight'><strong class='" + trendClass + "'>" + message + "</strong></div>";
    }).join('');

    page.innerHTML =
      "<div class='today-shell'>" +
        "<div class='today-grid'>" +
          "<div class='card today-main'>" +
            "<div class='today-kicker'>O que estudar agora</div>" +
            (recommendation
              ? "<div class='today-title'>" + recommendation.discName + " - " + recommendation.topicName + "</div>" +
                "<div class='today-copy'>" + recommendation.reason + "</div>" +
                "<div class='today-meta'>" +
                  "<span class='today-badge'>Prioridade " + recommendation.priorityLabel + "</span>" +
                  "<span class='today-badge'>" + (recommendation.accuracy === null ? "Sem acertos ainda" : recommendation.accuracy + "% de acerto") + "</span>" +
                  "<span class='today-badge'>" + (recommendation.idleDays >= 999 ? "Nao estudado ainda" : recommendation.idleDays + " dia(s) sem estudar") + "</span>" +
                  "<span class='today-badge'>" + recommendation.reviewCount + " revisao(oes) pendente(s)</span>" +
                "</div>" +
                "<div class='today-actions'>" +
                  "<button class='btn btn-primary' onclick='startSmartStudy()'>Estudar agora</button>" +
                  "<button class='btn btn-secondary' onclick=\"go('plan')\">Escolher manualmente</button>" +
                  "<button class='btn btn-auth' onclick=\"SmartStudy.adjustPriority('up')\">+ Prioridade</button>" +
                  "<button class='btn btn-auth' onclick=\"SmartStudy.adjustPriority('down')\">- Prioridade</button>" +
                  "<button class='btn btn-ghost' onclick='SmartStudy.ignoreRecommendation()'>Ignorar hoje</button>" +
                "</div>"
              : "<div class='today-copy'>Ainda nao ha dados suficientes para recomendar. Registre uma sessao ou adicione topicos.</div>") +
          "</div>" +
          "<div class='today-stack'>" +
            "<div class='card today-mini'><div class='card-title'>Revisoes pendentes</div><div class='stat-val' style='color:var(--amber)'>" + summary.dueCount + "</div><div class='stat-sub'>Revise o que ficou aberto antes de acumular.</div></div>" +
            "<div class='card today-mini'><div class='card-title'>Desempenho recente</div><div class='stat-val " + (summary.performance.diff !== null && summary.performance.diff < 0 ? "trend-down" : "trend-up") + "'>" + (summary.performance.currentAvg === null ? "—" : summary.performance.currentAvg + "%") + "</div><div class='stat-sub'>" + trendLabel + "</div></div>" +
            "<div class='card today-mini'><div class='card-title'>Tempo estudado</div><div class='stat-val' style='color:var(--blue)'>" + fmtH(summary.weeklySeconds) + "</div><div class='stat-sub'>Acumulado nos ultimos 7 dias.</div></div>" +
          "</div>" +
        "</div>" +
        renderPlannerSection() +
        "<div class='card' style='padding:18px 18px 16px'><div class='card-title'>Leituras rápidas</div><div class='smart-insights'>" + (insightHtml || "<div class='smart-insight'>Registre questoes em mais de uma disciplina para gerar insights de tendencia.</div>") + "</div></div>" +
      "</div>";
  }

  function renderSmartStats(){
    var originalRenderStats = renderStats;
    renderStats = function(){
      originalRenderStats();
      var cards = document.getElementById('stats-cards');
      var tips = document.getElementById('stats-tips');
      if(cards){
        var summary = getWeeklyPerformanceSummary();
        var trendClass = summary.diff !== null && summary.diff < 0 ? 'trend-down' : 'trend-up';
        cards.innerHTML += "<div class='stat-card'><div class='stat-lbl'>Comparacao semanal</div><div class='stat-val " + trendClass + "'>" + (summary.currentAvg === null ? "—" : summary.currentAvg + "%") + "</div><div class='stat-sub'>" + (summary.diff === null ? "Ainda sem base" : (summary.diff >= 0 ? "Subiu " + summary.diff + " ponto(s)" : "Caiu " + Math.abs(summary.diff) + " ponto(s)")) + "</div></div>";
      }
      if(tips){
        var insights = getDisciplineInsights();
        if(insights.length){
          tips.innerHTML = insights.slice(0, 4).map(function(item){
            if(item.delta === null) return "<div class='alert alert-info'>Base inicial em <strong>" + item.discName + "</strong>.</div>";
            if(item.delta < 0) return "<div class='alert alert-warn'>Queda de desempenho em <strong>" + item.discName + "</strong>: " + Math.abs(item.delta) + " ponto(s).</div>";
            return "<div class='alert alert-ok'>Melhora recente em <strong>" + item.discName + "</strong>: +" + item.delta + " ponto(s).</div>";
          }).join('');
        }
      }
    };
  }

  function enhanceStopTimer(){
    var originalStopTimer = stopTimer;
    stopTimer = function(){
      var context = SmartStudy.activeContext;
      originalStopTimer();
      if(!context) return;
      lastTopicId = context.topicId || lastTopicId;
      var topic = context.topicId ? findTopic(context.discId, context.topicId) : null;
      if(topic){
        topic.lastStudiedAt = Date.now();
      }
      save();
      var doneMessage = document.getElementById('done-msg');
      if(doneMessage){
        doneMessage.textContent = (context.discName || '') + ' - ' + (context.topicName || 'Sessao geral') + '. Sessao registrada. Agora faca questoes e deixe a revisao ser agendada automaticamente.';
      }
      SmartStudy.activeContext = null;
    };
  }

  function init(){
    injectSmartStyles();
    renderHome = renderTodayHome;
    renderSmartStats();
    enhanceStopTimer();
    window.SmartStudy = SmartStudy;
    if(document.getElementById('page-home') && document.getElementById('page-home').classList.contains('active')){
      renderHome();
    }
  }

  init();
})();
