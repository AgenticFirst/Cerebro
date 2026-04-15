// ── Spanish translations ────────────────────────────────────────
// Must mirror the exact key structure of en.ts.

import type { TranslationKeys } from './en';

const es: TranslationKeys = {
  // ── Comunes / reutilizables ─────────────────────────────────
  common: {
    loading: 'Cargando...',
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    dismiss: 'Descartar',
    retry: 'Reintentar',
    or: 'o',
    search: 'Buscar...',
    optional: '(opcional)',
    creating: 'Creando...',
    saving: 'Guardando...',
    comingSoon: 'Pr\u00f3ximamente',
    new: 'NUEVO',
    default: 'predeterminado',
    none: 'Ninguno',
  },

  // ── Barra lateral / navegaci\u00f3n ─────────────────────────────
  nav: {
    chat: 'Chat',
    tasks: 'Tareas',
    experts: 'Expertos',
    routines: 'Rutinas',
    activity: 'Actividad',
    approvals: 'Aprobaciones',
    integrations: 'Integraciones',
    skills: 'Habilidades',
    settings: 'Ajustes',
    newChat: 'Nuevo chat',
    expandSidebar: 'Expandir barra lateral',
    collapseSidebar: 'Contraer barra lateral',
    deleteConversation: 'Eliminar conversaci\u00f3n',
    noConversationsYet: 'A\u00fan no hay conversaciones',
  },

  // ── Grupos temporales de conversaciones ─────────────────────
  timeGroups: {
    today: 'Hoy',
    yesterday: 'Ayer',
    previous7Days: '\u00daltimos 7 d\u00edas',
    older: 'Anteriores',
  },

  // ── Chat ────────────────────────────────────────────────────
  chat: {
    welcomeTitle: '\u00bfEn qu\u00e9 podemos ayudarte?',
    welcomeSubtitle:
      'Chatea con Cerebro o consulta a un experto \u2014 planificaremos, ejecutaremos y daremos seguimiento.',
    sendPlaceholder: 'Escribe un mensaje...',
    attachFiles: 'Adjuntar archivos',
    dropToAttach: 'Suelta archivos para adjuntar',
    thinking: 'Cerebro est\u00e1 pensando',
    you: 'T\u00fa',
    cerebro: 'Cerebro',
  },

  // ── Tarjeta de llamada a herramienta ────────────────────────
  toolCall: {
    task: 'Tarea',
    arguments: 'Argumentos',
    response: 'Respuesta',
    output: 'Salida',
    waitingFor: 'Esperando a {{name}}...',
    runningElapsed: 'Ejecutando... {{seconds}}s',
    running: 'Ejecutando...',
  },

  // ── Tarjeta de registro de ejecuci\u00f3n ───────────────────────
  runLog: {
    previewRun: 'Ejecuci\u00f3n de prueba',
    routineRun: 'Ejecuci\u00f3n de rutina',
    cancelRun: 'Cancelar ejecuci\u00f3n',
    stepsProgress: '{{done}}/{{total}} pasos',
  },

  // ── Etiquetas de estado (compartidas) ───────────────────────
  status: {
    running: 'Ejecutando',
    completed: 'Completado',
    failed: 'Fallido',
    cancelled: 'Cancelado',
    paused: 'Pausado',
    pending: 'Pendiente',
    created: 'Creado',
    clarifying: 'Aclarando',
    needsInput: 'Requiere entrada',
    planning: 'Planificando',
    proposed: 'Propuesto',
    reviewing: 'En revisi\u00f3n',
    saved: 'Guardado',
    dismissed: 'Descartado',
    previewing: 'Previsualizando',
    approved: 'Aprobado',
    denied: 'Denegado',
    expired: 'Expirado',
    active: 'Activo',
    disabled: 'Desactivado',
  },

  // ── Tarjeta de propuesta de experto ─────────────────────────
  expertProposal: {
    preview: 'Vista previa',
    collapse: 'Contraer',
    saveExpert: 'Guardar experto',
    savedAsExpert: 'Guardado como experto',
    contextFileIncluded: 'Archivo de contexto incluido',
    tool_one: '{{count}} herramienta',
    tool_other: '{{count}} herramientas',
  },

  // ── Tarjeta de propuesta de rutina ──────────────────────────
  routineProposal: {
    saveRoutine: 'Guardar rutina',
    savedAsRoutine: 'Guardada como rutina',
    approvalGate_one: '{{count}} puerta de aprobaci\u00f3n',
    approvalGate_other: '{{count}} puertas de aprobaci\u00f3n',
  },

  // ── Tarjeta de propuesta de equipo ──────────────────────────
  teamProposal: {
    members: 'Miembros ({{count}})',
    coordinatorPrompt: 'Prompt del coordinador',
    details: 'Detalles',
    saveTeam: 'Guardar equipo',
    savedAsTeam: 'Guardado como equipo',
  },

  // ── Tarjeta de ejecuci\u00f3n de equipo ─────────────────────────
  teamRun: {
    completedProgress: '{{done}}/{{total}} completados',
  },

  // ── Bandeja de expertos ─────────────────────────────────────
  expertTray: {
    cerebro: 'Cerebro',
  },

  // ── Etiquetas de disparadores ───────────────────────────────
  triggers: {
    manual: 'Manual',
    scheduled: 'Programado',
    webhook: 'Webhook',
    chat: 'Chat',
    scheduleTrigger: 'Disparador programado',
    manualTrigger: 'Disparador manual',
    webhookTrigger: 'Disparador de webhook',
    appEventTrigger: 'Disparador de evento de app',
    trigger: 'Disparador',
    noScheduleSet: 'Sin programaci\u00f3n definida',
    clickRunToExecute: 'Haz clic en "Ejecutar" para iniciar',
    notConfigured: 'No configurado',
  },

  // ── Banner de sandbox ───────────────────────────────────────
  sandboxBanner: {
    title: 'Los agentes tienen acceso completo a tu Mac',
    description:
      'Activa el sandbox para confinar a Cerebro a un espacio de trabajo y los proyectos que vincules expl\u00edcitamente. Puedes habilitarlo en unos segundos.',
    enableSandbox: 'Activar sandbox',
    notNow: 'Ahora no',
    dismissAria: 'Descartar banner de sandbox',
  },

  // ── Pantalla de tareas ──────────────────────────────────────
  tasks: {
    title: 'Tareas',
    newTask: 'Nueva tarea',
    noTasksYet: 'A\u00fan no hay tareas',
    noFilteredTasks: 'No hay tareas {{status}}',
    filterAll: 'Todas',
    filterRunning: 'Ejecutando',
    filterDone: 'Completadas',
    filterFailed: 'Fallidas',
    emptyTitle: 'Dale un objetivo a Cerebro. \u00c9l se encarga de todo.',
    emptyDescription:
      'Describe lo que quieres \u2014 una presentaci\u00f3n, una app, un informe \u2014 y Cerebro descompondr\u00e1 el objetivo, asignar\u00e1 expertos, ejecutar\u00e1 cada fase y entregar\u00e1 el resultado.',
    suggestionPresentation:
      'Crea una presentaci\u00f3n sobre tendencias de IA en 2026',
    suggestionCompetitors:
      'Investiga competidores en software de RRHH y escribe un informe de posicionamiento',
    suggestionFitbod:
      'Dise\u00f1a un clon de Fitbod \u2014 especificaci\u00f3n de producto y plan por fases',
    suggestionTrip:
      'Planifica un viaje de 10 d\u00edas a Kioto para primavera de 2026',
    suggestionPomodoro:
      'Crea una app web de temporizador pomodoro con modo oscuro',
    suggestionMealPlan:
      'Crea un plan de comidas de 7 d\u00edas con lista de compras',
  },

  // ── Di\u00e1logo de nueva tarea ─────────────────────────────────
  newTaskDialog: {
    title: 'Nueva tarea',
    placeholder:
      '\u00bfQu\u00e9 quieres que haga Cerebro? Presentaci\u00f3n, app, investigaci\u00f3n, lo que sea \u2014 \u00e9l se encarga.',
    skipClarification: 'Omitir aclaraci\u00f3n \u2014 ejecutar directamente',
    advanced: 'Avanzado',
    model: 'Modelo',
    modelSonnet: 'Sonnet (predeterminado)',
    modelOpus: 'Opus (potente)',
    modelHaiku: 'Haiku (ligero)',
    maxPhases: 'M\u00e1x. fases: {{value}}',
    maxTurns: 'M\u00e1x. turnos: {{value}}',
    startTask: 'Iniciar tarea',
    templatePresentation: 'Presentaci\u00f3n',
    templateWebApp: 'App web',
    templateMobileApp: 'App m\u00f3vil (Expo)',
    templateResearchBrief: 'Informe de investigaci\u00f3n',
    templateTripPlan: 'Plan de viaje',
    templateCodeAudit: 'Auditor\u00eda de c\u00f3digo',
    templateMealPlan: 'Plan de comidas',
    templateCliTool: 'Herramienta CLI',
  },

  // ── Panel de detalle de tarea ───────────────────────────────
  taskDetail: {
    tabPlan: 'Plan',
    tabConsole: 'Consola',
    tabDeliverable: 'Entregable',
    tabWorkspace: 'Espacio de trabajo',
    tabPreview: 'Vista previa',
    waitingForOutput: 'Esperando salida...',
    noOutput: 'Sin salida',
    codeApp: 'App de c\u00f3digo',
    mixed: 'Mixto',
    markdown: 'Markdown',
    starting: 'Iniciando...',
    start: 'Iniciar',
    previewFailed: 'Vista previa fallida',
    failedToStartPreview: 'Error al iniciar el servidor de vista previa',
    previewStopped: 'El servidor de vista previa se detuvo inesperadamente',
    watchingForContent: 'Buscando contenido...',
    watchingForContentHint: 'La vista previa aparecerá cuando se creen archivos',
    followUpPlaceholder: 'Haz una pregunta de seguimiento...',
    taskNotFound: 'Tarea no encontrada',
    cancelTask: 'Cancelar tarea',
    deleteTask: 'Eliminar tarea',
    phasesProgress: '{{done}}/{{total}} fases',
    approveAndExecute: 'Aprobar y ejecutar',
  },

  taskPlan: {
    writingPlan: 'Cerebro est\u00e1 escribiendo tu plan...',
    noPlan: 'Sin plan disponible',
    checkboxToggleFailed: 'No se pudo actualizar PLAN.md. Int\u00e9ntalo de nuevo.',
  },

  // ── Editor de rutinas ───────────────────────────────────────
  routineEditor: {
    setSchedule: 'Definir programaci\u00f3n',
    savingInProgress: 'Guardado en progreso...',
    noPromptSet: 'Sin prompt definido',
    noTaskSet: 'Sin tarea definida',
    noCategoriesDefined: 'Sin categor\u00edas definidas',
    noSchemaDefined: 'Sin esquema definido',
    noQuerySet: 'Sin consulta definida',
    noCommandSet: 'Sin comando definido',
    waitingForWebhook: 'Esperando webhook',
    noItemsField: 'Sin campo de elementos',
    approvalCheckpoint: 'Punto de aprobaci\u00f3n',
    noMessageSet: 'Sin mensaje definido',
    noTitleSet: 'Sin t\u00edtulo definido',
    never: 'Nunca',
    justNow: 'Justo ahora',
    notifyOnCompletion: 'Notificar al completar',
    notifyViaTelegram: 'v\u00eda Telegram',
    notifyCount: '{{count}} v\u00eda Telegram',
    notifyCount_one: '{{count}} v\u00eda Telegram',
    notifyNoAllowlist: 'Primero conecta Telegram en Integraciones y a\u00f1ade IDs a la lista de permitidos.',
    notifyHint: 'Elige uno o m\u00e1s destinatarios de Telegram. Recibir\u00e1n un mensaje cuando esta rutina termine o falle.',
    notifyClear: 'Limpiar notificaciones',
    notifyChannelTelegram: 'Telegram',
  },

  // ── Pantalla de expertos ────────────────────────────────────
  experts: {
    addExpert: 'Agregar experto',
    newExpert: 'Nuevo experto',
    filterAll: 'Todos',
    filterActive: 'Activos',
    filterDisabled: 'Desactivados',
    filterPinned: 'Fijados',
    zoomIn: 'Acercar',
    zoomOut: 'Alejar',
    resetView: 'Restablecer vista',
    leadExpert: 'EXPERTO PRINCIPAL',
    alwaysAvailable:
      'Siempre disponible. Planifica, delega, aprende y resuelve.',
    capabilities: 'CAPACIDADES',
    capResponds: 'Responde directamente',
    capRoutes: 'Dirige a expertos',
    capRoutines: 'Propone rutinas',
    capDrafts: 'Dise\u00f1a especialistas',
    capMemory: 'Gestiona la memoria',
    statusLabel: 'ESTADO',
    expert_one: '{{count}} experto activo',
    expert_other: '{{count}} expertos activos',
    pinned: '{{count}} fijados',
    nodeId: 'ID DE NODO',
    details: 'DETALLES',
    name: 'Nombre',
    domain: 'Dominio',
    description: 'Descripci\u00f3n',
    avatar: 'Avatar',
    teamMembers: 'MIEMBROS DEL EQUIPO',
    configuration: 'Configuraci\u00f3n',
    callExpert: 'Llamar al experto',
    removeFromTeam: 'Quitar del equipo',
    noMembersYet: 'A\u00fan no hay miembros.',
    noAvailableExperts: 'No hay expertos disponibles para agregar.',
    addMember: 'Agregar miembro',
    skills: 'HABILIDADES',
    systemContext: 'CONTEXTO DEL SISTEMA',
    systemPromptPlaceholder: 'Define el comportamiento y la personalidad de este experto...',
    settingsSection: 'AJUSTES',
    enabled: 'Habilitado',
    pinnedLabel: 'Fijado',
    memorySection: 'MEMORIA',
    infoSection: 'INFO',
    source: 'Fuente',
    type: 'Tipo',
    versionLabel: 'Versi\u00f3n',
    lastActive: '\u00daltima actividad',
    deleteExpert: 'Eliminar experto',
    alwaysActive: 'Siempre activo',
    connected: 'Conectado',
  },

  // ── Di\u00e1logo de crear experto ───────────────────────────────
  createExpert: {
    newExpert: 'Nuevo experto',
    newTeam: 'Nuevo equipo',
    typeLabel: 'Tipo',
    typeExpert: 'Experto',
    typeTeam: 'Equipo',
    namePlaceholderExpert: 'ej. Analista de investigaci\u00f3n',
    namePlaceholderTeam: 'ej. Divisi\u00f3n de investigaci\u00f3n',
    descPlaceholderExpert: '\u00bfQu\u00e9 hace este experto?',
    descPlaceholderTeam: '\u00bfQu\u00e9 maneja este equipo?',
    membersSelected: '({{count}} seleccionados)',
    membersEmpty:
      'Crea expertos individuales primero y luego agr\u00e9galos a un equipo.',
    createExpert: 'Crear experto',
    createTeam: 'Crear equipo',
  },

  // ── Tiempo relativo en panel de detalle ─────────────────────
  timeAgo: {
    never: 'Nunca',
    justNow: 'Justo ahora',
    minutesAgo: 'Hace {{count}}m',
    hoursAgo: 'Hace {{count}}h',
    daysAgo: 'Hace {{count}}d',
  },

  // ── Dominios ────────────────────────────────────────────────
  domains: {
    productivity: 'Productividad',
    health: 'Salud',
    finance: 'Finanzas',
    creative: 'Creativo',
    engineering: 'Ingenier\u00eda',
    research: 'Investigaci\u00f3n',
  },

  // ── Rutinas ─────────────────────────────────────────────────
  routines: {
    title: 'Rutinas',
    total: '{{count}} en total',
    active: '{{count}} activas',
    newRoutine: 'Nueva rutina',
    filterAll: 'Todas',
    filterEnabled: 'Habilitadas',
    filterScheduled: 'Programadas',
    filterManual: 'Manuales',
    noRoutinesYet: 'A\u00fan no hay rutinas',
    noRoutinesDescription:
      'Las rutinas automatizan tareas de m\u00faltiples pasos. Crea tu primera rutina para comenzar.',
    createFirst: 'Crea tu primera rutina',
    noMatchSearch: 'Ninguna rutina coincide con tu b\u00fasqueda.',
    noMatchFilter: 'Ninguna rutina coincide con tu filtro.',
    lastRun: 'Última ejecución',
    runs: 'Ejecuciones',
    runNow: 'Ejecutar ahora',
    deleteRoutine: 'Eliminar rutina',
    deleteConfirm:
      '\u00bfEliminar "{{name}}"? Esta acci\u00f3n no se puede deshacer.',
  },

  // ── Di\u00e1logo de crear rutina ────────────────────────────────
  createRoutine: {
    title: 'Nueva rutina',
    name: 'Nombre',
    namePlaceholder: 'ej. Resumen diario de standup',
    description: 'Descripci\u00f3n',
    descPlaceholder: '\u00bfQu\u00e9 hace esta rutina?',
    trigger: 'Disparador',
    triggerManualDesc: 'Ejecutar bajo demanda',
    triggerScheduledDesc: 'Ejecutar con programaci\u00f3n',
    triggerWebhookDesc: 'Ejecutar v\u00eda webhook',
    schedule: 'Programaci\u00f3n',
    createRoutine: 'Crear rutina',
  },

  // ── Pantalla de actividad ───────────────────────────────────
  activity: {
    title: 'Actividad',
    total: '{{count}} en total',
    noActivityYet: 'A\u00fan no hay actividad',
    noActivityDescription:
      'Tu l\u00ednea de tiempo mostrar\u00e1 ejecuciones de rutinas, delegaciones y orquestaciones a medida que ocurran.',
    startConversation: 'Iniciar una conversaci\u00f3n',
    noMatchFilters: 'Ninguna ejecuci\u00f3n coincide con tus filtros.',
    stepsProgress: '{{completed}}/{{total}} pasos',
    awaitingApproval: 'Esperando aprobaci\u00f3n',
    runDetails: 'Detalles de ejecuci\u00f3n',
    run: 'Ejecuci\u00f3n',
    started: 'Iniciada',
    finished: 'Finalizada',
    runNotFound: 'Ejecuci\u00f3n no encontrada.',
    failedToLoadDetails: 'Error al cargar los detalles de la ejecuci\u00f3n.',
    tabSteps: 'Pasos',
    tabEvents: 'Eventos',
    tabChildren: 'Hijos',
    today: 'Hoy, {{time}}',
    yesterday: 'Ayer, {{time}}',
    loadMore: 'Cargar m\u00e1s ({{count}} restantes)',
    failedToLoad: 'Error al cargar la actividad',
    filter: {
      all: 'Todas',
      running: 'Ejecutando',
      paused: 'Pausadas',
      completed: 'Completadas',
      failed: 'Fallidas',
      cancelled: 'Canceladas',
      routine: 'Rutina',
      preview: 'Vista previa',
      ad_hoc: 'Ad-Hoc',
      orchestration: 'Orquestaci\u00f3n',
      task: 'Tarea',
      manual: 'Manual',
      scheduled: 'Programada',
      chat: 'Chat',
      webhook: 'Webhook',
    },
  },

  // ── Pantalla de aprobaciones ────────────────────────────────
  approvals: {
    title: 'Aprobaciones',
    subtitle: 'Revisa y aprueba acciones pendientes',
    pendingTab: 'Pendientes',
    pendingTabCount: 'Pendientes ({{count}})',
    historyTab: 'Historial',
    noPending: 'No hay aprobaciones pendientes',
    noPendingDescription:
      'Cuando un paso de rutina requiera tu autorizaci\u00f3n, aparecer\u00e1 aqu\u00ed.',
    noHistory: 'A\u00fan no hay historial de aprobaciones',
    noHistoryDescription:
      'Las aprobaciones resueltas aparecer\u00e1n aqu\u00ed.',
    parameters: 'Par\u00e1metros',
    requested: 'Solicitada {{time}}',
    reason: 'Raz\u00f3n: ',
    resolved: 'Resuelta {{time}}',
    reasonPlaceholder: 'Raz\u00f3n (opcional)',
    confirm: 'Confirmar',
    deny: 'Denegar',
    approve: 'Aprobar',
  },

  // ── Pantalla de integraciones ───────────────────────────────
  integrations: {
    title: 'Integraciones',
    engine: 'Motor',
    connectedApps: 'Apps conectadas',
    channels: 'Canales',
    remoteAccess: 'Acceso remoto',
    remoteAccessDescription:
      'Habilita eventos entrantes y disparadores remotos para que Cerebro te atienda cuando no est\u00e9s.',
    remoteAccessComingSoon:
      'El relay de salida, endpoints de webhook y emparejamiento de identidad estar\u00e1n disponibles en una versi\u00f3n futura.',
  },

  // ── Secci\u00f3n del motor ───────────────────────────────────────
  engineSection: {
    title: 'Motor',
    description:
      'Cerebro usa el CLI de Claude Code como su motor de inferencia. Todos los expertos, rutinas y conversaciones funcionan con subagentes de Claude Code.',
    claudeCode: 'Claude Code',
    claudeCodeDesc: 'El CLI oficial de Anthropic para Claude',
    detected: 'Detectado',
    detecting: 'Detectando\u2026',
    notFound: 'No encontrado',
    error: 'Error',
    version: 'Versi\u00f3n',
    path: 'Ruta',
    notFoundMessage:
      'Cerebro no pudo encontrar el CLI de Claude Code en tu sistema.',
    notFoundError: '({{error}})',
    installGuide: 'Inst\u00e1lalo desde',
    installGuideLink: 'la gu\u00eda oficial de configuraci\u00f3n',
    installGuideAfter:
      'y haz clic en Re-detectar una vez instalado.',
    redetect: 'Re-detectar',
  },

  // ── Secci\u00f3n de apps conectadas ──────────────────────────────
  connectedApps: {
    title: 'Apps conectadas',
    description:
      'Conecta servicios externos para que Cerebro pueda leer y escribir en tu nombre. La b\u00fasqueda web ya est\u00e1 disponible de serie a trav\u00e9s de la herramienta WebSearch integrada de Claude Code.',
    googleCalendar: 'Google Calendar',
    googleCalendarDesc: 'Eventos de calendario y programaci\u00f3n',
    gmail: 'Gmail',
    gmailDesc: 'Leer y enviar correos',
    notion: 'Notion',
    notionDesc: 'P\u00e1ginas, bases de datos y base de conocimiento',
    slack: 'Slack',
    slackDesc: 'Mensajer\u00eda de equipo y notificaciones',
  },

  // ── Secci\u00f3n de canales ──────────────────────────────────────
  channelsSection: {
    title: 'Canales',
    description:
      'Conecta plataformas de mensajer\u00eda para interactuar con Cerebro de forma remota.',
    telegram: 'Telegram',
    telegramDesc: 'Env\u00eda mensajes a Cerebro a trav\u00e9s del bot de Telegram',
    whatsapp: 'WhatsApp',
    whatsappDesc: 'Chatea con Cerebro en WhatsApp',
    email: 'Correo electr\u00f3nico',
    emailDesc: 'Interact\u00faa con Cerebro v\u00eda correo electr\u00f3nico',
  },

  // ── Secci\u00f3n de Telegram ─────────────────────────────────────
  telegramSection: {
    title: 'Telegram',
    description:
      'Chatea con Cerebro desde tu tel\u00e9fono. Cerebro escucha mediante long-polling, as\u00ed que no necesita URL p\u00fablica ni t\u00fanel — el puente corre dentro de Cerebro y se detiene al cerrar la aplicaci\u00f3n.',
    tokenLabel: 'Token del bot',
    tokenPlaceholder: 'Pega el token de @BotFather',
    verify: 'Verificar',
    verifying: 'Verificando...',
    verified: 'Verificado',
    allowlistLabel: 'IDs de usuario permitidos',
    allowlistHelp: 'Solo estos IDs de usuario de Telegram pueden chatear con el bot. Separa varios IDs con comas.',
    allowlistPlaceholder: '123456789, 987654321',
    forwardAllLabel: 'Reenviar todas las aprobaciones a Telegram',
    forwardAllHelp: 'Desactivado por defecto: solo se env\u00edan las aprobaciones de ejecuciones iniciadas desde Telegram. Act\u00edvalo si tambi\u00e9n quieres recibir en el tel\u00e9fono las aprobaciones iniciadas desde el escritorio.',
    enableLabel: 'Activar puente',
    enableDisabledHint: 'Verifica el token y agrega al menos un ID de usuario para activar.',
    statusRunning: 'En ejecuci\u00f3n',
    statusStopped: 'Detenido',
    lastPoll: '\u00daltimo contacto',
    lastError: '\u00daltimo error',
    never: 'nunca',
    howToTitle: 'C\u00f3mo obtener tu ID de usuario de Telegram',
    howToSteps:
      '1. Abre Telegram y busca tu bot por su nombre de usuario.\n2. Pulsa Iniciar y env\u00eda cualquier mensaje.\n3. El bot responde con un mensaje que contiene tu ID num\u00e9rico.\n4. Pega ese n\u00famero en la lista de permitidos de arriba.',
    warningPlaintext:
      'Los tokens se almacenan localmente en tu base de datos en texto plano. Si tu m\u00e1quina se ve comprometida, revoca el token con @BotFather y crea uno nuevo.',
    save: 'Guardar',
    saved: 'Guardado',
  },

  // ── Biblioteca de habilidades ───────────────────────────────
  skills: {
    title: 'Biblioteca de habilidades',
    searchPlaceholder: 'Buscar habilidades...',
    newSkill: 'Nueva habilidad',
    filterAll: 'Todas',
    filterMine: 'M\u00edas',
    loadingSkills: 'Cargando habilidades...',
    noMatchingSkills: 'No se encontraron habilidades.',
    noSkillsFound: 'No se encontraron habilidades.',
    emptyTitle: 'Biblioteca de habilidades',
    emptyDescription:
      'Las habilidades son capacidades reutilizables que puedes asignar a expertos. Selecciona una habilidad o agrega una nueva.',
    importSkill: 'Importar habilidad',
    createManually: 'Crear manualmente',
    addSkill: 'Agregar habilidad',
    importTab: 'Importar',
    createTab: 'Crear manualmente',
    importDescription:
      'Importa una habilidad desde GitHub, skills.sh o cualquier URL que aloje un archivo SKILL.md.',
    importPlaceholder: 'Pega una URL, comando npx o propietario/repo...',
    importFailed: 'Error al importar',
    fetchingSkill: 'Obteniendo habilidad...',
    import: 'Importar',
    importSuccess:
      'Importada exitosamente. Revisa los detalles a continuaci\u00f3n y guarda.',
    supportedFormats: 'FORMATOS SOPORTADOS',
    formatNpx: 'comando npx',
    formatGithubShort: 'atajo de GitHub',
    formatGithubUrl: 'URL de GitHub',
    formatSkillsSh: 'skills.sh',
    formatDirectUrl: 'URL directa',
    nameLabel: 'NOMBRE',
    namePlaceholder: 'ej. An\u00e1lisis financiero, Pruebas de API',
    categoryLabel: 'CATEGOR\u00cdA',
    iconLabel: '\u00cdCONO',
    descriptionLabel: 'DESCRIPCI\u00d3N',
    descriptionPlaceholder:
      'Una oraci\u00f3n explicando qu\u00e9 ense\u00f1a esta habilidad a un experto.',
    instructionsLabel: 'INSTRUCCIONES',
    markdownSupported: 'Compatible con Markdown',
    instructionsPlaceholder:
      'Escribe o pega las instrucciones de la habilidad aqu\u00ed. Este markdown se inyecta en el prompt del sistema del experto cuando se asigna esta habilidad.',
    createSkill: 'Crear habilidad',
    toolsLabel: 'HERRAMIENTAS',
    assignedTo: 'ASIGNADA A',
    notAssigned: 'No asignada a ning\u00fan experto.',
    allExpertsHaveSkill: 'Todos los expertos ya tienen esta habilidad.',
    assignToExpert: 'Asignar a experto',
    builtInReadOnly: 'Integrada \u2014 solo lectura',
    sourceVersion: '{{source}} \u00b7 v{{version}}',
    categoryAll: 'Todas las habilidades',
    categoryGeneral: 'General',
    categoryEngineering: 'Ingenier\u00eda',
    categoryContent: 'Contenido',
    categoryOperations: 'Operaciones',
    categorySupport: 'Soporte',
    categoryFinance: 'Finanzas',
    categoryFitness: 'Fitness',
    categoryProductivity: 'Productividad',
  },

  // ── Pantalla de ajustes ─────────────────────────────────────
  settings: {
    title: 'Ajustes',
    memory: 'Memoria',
    sandbox: 'Sandbox',
    appearance: 'Apariencia',
    about: 'Acerca de',
    aboutComingSoon: 'Acerca de Cerebro pr\u00f3ximamente',
  },

  // ── Secci\u00f3n de apariencia ───────────────────────────────────
  appearance: {
    title: 'Apariencia',
    description: 'Personaliza c\u00f3mo se ve y se comporta Cerebro.',
    showHistoricalLogs: 'Mostrar registros hist\u00f3ricos de pasos',
    showHistoricalLogsDesc:
      'Muestra los registros paso a paso al ver ejecuciones pasadas de rutinas. Los registros siempre se graban \u2014 esto controla si aparecen en la interfaz.',
    language: 'Idioma',
    languageDesc:
      'Elige el idioma de la interfaz de Cerebro. Las respuestas de la IA tambi\u00e9n se adaptar\u00e1n al idioma seleccionado.',
  },

  // ── Secci\u00f3n de memoria ──────────────────────────────────────
  memory: {
    title: 'Memoria',
    description:
      'Cada agente tiene su propio directorio de memoria. Estos archivos markdown son le\u00eddos por el agente al inicio de cada turno y editados a medida que aprende.',
    agents: 'Agentes',
    noAgentsYet: 'A\u00fan no hay agentes.',
    files: 'Archivos',
    newFile: 'Nuevo archivo',
    newFilePlaceholder: 'notas.md',
    noFilesYet: 'A\u00fan no hay archivos.',
    selectFile: 'Selecciona un archivo o crea uno nuevo.',
    selectAgent: 'Selecciona un agente para ver su memoria.',
    lastUpdated: '\u00daltima actualizaci\u00f3n: {{time}}',
    editorPlaceholder:
      'Escribe markdown que el agente deber\u00eda leer en cada turno...',
  },

  // ── Secci\u00f3n de sandbox ──────────────────────────────────────
  sandbox: {
    title: 'Sandbox',
    description:
      'Restringe lo que los agentes de Cerebro pueden leer y escribir en tu Mac. El sandbox es un perfil Seatbelt de macOS envuelto alrededor del subproceso de Claude Code \u2014 las operaciones denegadas fallan con un error de permiso en lugar de tocar tus archivos.',
    enableSandbox: 'Activar sandbox',
    macOsOnly: 'Solo macOS (v1)',
    activeDesc:
      'Los agentes solo pueden acceder al espacio de trabajo y los proyectos vinculados.',
    inactiveDesc:
      'Los agentes tienen acceso sin restricciones a tus archivos.',
    disableSandbox: 'Desactivar sandbox',
    disableConfirmTitle: '\u00bfDesactivar sandbox?',
    disableConfirmDesc:
      'Cada ejecuci\u00f3n de agente a partir de este momento tendr\u00e1 acceso completo a tu directorio personal y cada archivo que puedas leer o escribir.',
    yesDisable: 'S\u00ed, desactivar',
    keepEnabled: 'Mantener activado',
    workspace: 'Espacio de trabajo',
    cerebroWorkspace: 'Espacio de trabajo de Cerebro',
    openInFinder: 'Abrir en Finder',
    workspaceDescription:
      'Siempre lectura-escritura. Los agentes usan este directorio por defecto cuando necesitan un espacio temporal. Tus proyectos existentes est\u00e1n en otro lugar \u2014 vinc\u00falalos a continuaci\u00f3n.',
    linkedProjects: 'Proyectos vinculados',
    linkProject: 'Vincular proyecto',
    noProjectsLinked:
      'A\u00fan no hay proyectos vinculados. Haz clic en Vincular proyecto para dar acceso a Cerebro a un directorio espec\u00edfico \u2014 por ejemplo ~/Desktop/projects/mi-repo.',
    newLinksReadOnly:
      'Los nuevos v\u00ednculos son de solo lectura por defecto. Promoci\u00f3nalos a lectura-escritura por proyecto cuando quieras que los agentes hagan cambios.',
    readWrite: 'Lectura-escritura',
    readOnly: 'Solo lectura',
    allowWrites: 'Permitir escritura',
    makeReadOnly: 'Hacer solo lectura',
    promoteToReadWrite: 'Promover a lectura-escritura',
    revertToReadOnly: 'Revertir a solo lectura',
    unlinkProject: 'Desvincular proyecto',
    confirmWriteTitle:
      '\u00bfPermitir a Cerebro escribir en este directorio?',
    confirmWriteDesc:
      'Los agentes podr\u00e1n crear, modificar y eliminar archivos en {{path}}.',
    yesAllowWrites: 'S\u00ed, permitir escritura',
    alwaysBlocked: 'Siempre bloqueados',
    blockedDescription:
      'Estas rutas est\u00e1n denegadas sin importar los v\u00ednculos que agregues. Cerebro se negar\u00e1 a vincular un directorio dentro de ellas.',
    viewSeatbeltProfile: 'Ver perfil de Seatbelt efectivo',
    cerebroDataDir: 'Directorio de datos de Cerebro',
  },

  // ── Pantalla de marcador de posici\u00f3n ────────────────────────
  placeholder: {
    experts:
      'Agentes especializados que manejan tareas en dominios espec\u00edficos. Cerebro dirige tus solicitudes al experto adecuado.',
    routines:
      'Playbooks reutilizables y ejecutables. Cr\u00e9alos desde el chat o explora las rutinas guardadas aqu\u00ed.',
    activity:
      'L\u00ednea de tiempo de todas las ejecuciones \u2014 ve registros, salidas, marcas de tiempo y profundiza en cualquier ejecuci\u00f3n.',
    approvals:
      'Revisa y aprueba o deniega acciones pendientes que requieren tu autorizaci\u00f3n antes de ejecutarse.',
    marketplace:
      'Explora e instala paquetes de expertos, paquetes de acciones y plantillas de rutinas.',
  },

  // ── Voz / llamada ──────────────────────────────────────────
  call: {
    modelsNotFound: 'Modelos de voz no encontrados',
    modelsNotInstalledPre:
      'Los modelos de voz no est\u00e1n instalados. Si est\u00e1s ejecutando desde el c\u00f3digo fuente, ejecuta el script de descarga primero:',
    modelsNotInstalledPost:
      'Esto descarga el modelo TTS Kokoro (~340 MB) al directorio voice-models/. Whisper STT se descarga autom\u00e1ticamente en el primer uso. Las builds de producci\u00f3n los incluyen autom\u00e1ticamente.',
    goBack: 'Volver',
    holdToTalk: 'Mant\u00e9n presionado para hablar (Espacio)',
    endCall: 'Terminar llamada (Esc)',
    hideCaptions: 'Ocultar subt\u00edtulos',
    showCaptions: 'Mostrar subt\u00edtulos',
    you: 'T\u00fa:',
  },

  // ── Modal de alerta ─────────────────────────────────────────
  alert: {
    defaultAction: 'Entendido',
  },
} as const;

export default es;
