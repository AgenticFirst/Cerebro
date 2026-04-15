// ── English translations (source of truth) ─────────────────────
// Every user-facing string in the Cerebro UI lives here.
// Keys are grouped by screen / component area.

const en = {
  // ── Common / reusable ───────────────────────────────────────
  common: {
    loading: 'Loading...',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    dismiss: 'Dismiss',
    retry: 'Retry',
    or: 'or',
    search: 'Search...',
    optional: '(optional)',
    creating: 'Creating...',
    saving: 'Saving...',
    comingSoon: 'Coming Soon',
    new: 'NEW',
    default: 'default',
    none: 'None',
  },

  // ── Sidebar / navigation ───────────────────────────────────
  nav: {
    chat: 'Chat',
    tasks: 'Tasks',
    experts: 'Experts',
    routines: 'Routines',
    activity: 'Activity',
    approvals: 'Approvals',
    integrations: 'Integrations',
    skills: 'Skills',
    settings: 'Settings',
    newChat: 'New Chat',
    expandSidebar: 'Expand sidebar',
    collapseSidebar: 'Collapse sidebar',
    deleteConversation: 'Delete conversation',
    noConversationsYet: 'No conversations yet',
  },

  // ── Conversation time groups ────────────────────────────────
  timeGroups: {
    today: 'Today',
    yesterday: 'Yesterday',
    previous7Days: 'Previous 7 Days',
    older: 'Older',
  },

  // ── Chat ────────────────────────────────────────────────────
  chat: {
    welcomeTitle: 'What can we help with?',
    welcomeSubtitle:
      "Chat with Cerebro or ask an expert \u2014 we'll plan, execute, and follow up.",
    sendPlaceholder: 'Send a message...',
    attachFiles: 'Attach files',
    dropToAttach: 'Drop files to attach',
    thinking: 'Cerebro is thinking',
    you: 'You',
    cerebro: 'Cerebro',
  },

  // ── Tool call card ──────────────────────────────────────────
  toolCall: {
    task: 'Task',
    arguments: 'Arguments',
    response: 'Response',
    output: 'Output',
    waitingFor: 'Waiting for {{name}}...',
    runningElapsed: 'Running... {{seconds}}s',
    running: 'Running...',
  },

  // ── Run log card ────────────────────────────────────────────
  runLog: {
    previewRun: 'Preview Run',
    routineRun: 'Routine Run',
    cancelRun: 'Cancel run',
    stepsProgress: '{{done}}/{{total}} steps',
  },

  // ── Status labels (shared across cards) ─────────────────────
  status: {
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    paused: 'Paused',
    pending: 'Pending',
    created: 'Created',
    clarifying: 'Clarifying',
    needsInput: 'Needs input',
    planning: 'Planning',
    proposed: 'Proposed',
    reviewing: 'Reviewing',
    saved: 'Saved',
    dismissed: 'Dismissed',
    previewing: 'Previewing',
    approved: 'Approved',
    denied: 'Denied',
    expired: 'Expired',
    active: 'Active',
    disabled: 'Disabled',
  },

  // ── Expert proposal card ────────────────────────────────────
  expertProposal: {
    preview: 'Preview',
    collapse: 'Collapse',
    saveExpert: 'Save Expert',
    savedAsExpert: 'Saved as expert',
    contextFileIncluded: 'Context file included',
    tool_one: '{{count}} tool',
    tool_other: '{{count}} tools',
  },

  // ── Routine proposal card ───────────────────────────────────
  routineProposal: {
    saveRoutine: 'Save Routine',
    savedAsRoutine: 'Saved as routine',
    approvalGate_one: '{{count}} approval gate',
    approvalGate_other: '{{count}} approval gates',
  },

  // ── Team proposal card ──────────────────────────────────────
  teamProposal: {
    members: 'Members ({{count}})',
    coordinatorPrompt: 'Coordinator Prompt',
    details: 'Details',
    saveTeam: 'Save Team',
    savedAsTeam: 'Saved as team',
  },

  // ── Team run card ───────────────────────────────────────────
  teamRun: {
    completedProgress: '{{done}}/{{total}} completed',
  },

  // ── Expert tray ─────────────────────────────────────────────
  expertTray: {
    cerebro: 'Cerebro',
  },

  // ── Trigger labels ──────────────────────────────────────────
  triggers: {
    manual: 'Manual',
    scheduled: 'Scheduled',
    webhook: 'Webhook',
    chat: 'Chat',
    scheduleTrigger: 'Schedule Trigger',
    manualTrigger: 'Manual Trigger',
    webhookTrigger: 'Webhook Trigger',
    appEventTrigger: 'App Event Trigger',
    trigger: 'Trigger',
    noScheduleSet: 'No schedule set',
    clickRunToExecute: 'Click "Run" to execute',
    notConfigured: 'Not configured',
  },

  // ── Sandbox banner ──────────────────────────────────────────
  sandboxBanner: {
    title: 'Agents currently have full access to your Mac',
    description:
      'Turn on the sandbox to confine Cerebro to a workspace and the projects you explicitly link. You can enable it in a few seconds.',
    enableSandbox: 'Enable sandbox',
    notNow: 'Not now',
    dismissAria: 'Dismiss sandbox banner',
  },

  // ── Tasks screen ────────────────────────────────────────────
  tasks: {
    title: 'Tasks',
    newTask: 'New task',
    noTasksYet: 'No tasks yet',
    noFilteredTasks: 'No {{status}} tasks',
    filterAll: 'All',
    filterRunning: 'Running',
    filterDone: 'Done',
    filterFailed: 'Failed',
    emptyTitle: "Give Cerebro a goal. It'll run the whole thing.",
    emptyDescription:
      'Describe what you want \u2014 a spec, an app, a research brief \u2014 and Cerebro will decompose the goal, hire experts, execute each phase, and deliver the result.',
    // Task suggestions
    suggestionPresentation: 'Build a presentation about AI trends in 2026',
    suggestionCompetitors:
      'Research competitors in HR software and write a positioning brief',
    suggestionFitbod:
      'Design a Fitbod clone \u2014 product spec and phased build plan',
    suggestionTrip: 'Plan a 10-day trip to Kyoto for spring 2026',
    suggestionPomodoro: 'Build a pomodoro timer web app with dark mode',
    suggestionMealPlan: 'Build a 7-day meal plan with shopping list',
  },

  // ── New task dialog ─────────────────────────────────────────
  newTaskDialog: {
    title: 'New Task',
    placeholder:
      "What do you want Cerebro to do? Spec, app, research, whatever \u2014 it'll figure it out.",
    skipClarification: 'Skip clarification \u2014 just run it',
    advanced: 'Advanced',
    model: 'Model',
    modelSonnet: 'Sonnet (default)',
    modelOpus: 'Opus (powerful)',
    modelHaiku: 'Haiku (light)',
    maxPhases: 'Max phases: {{value}}',
    maxTurns: 'Max turns: {{value}}',
    startTask: 'Start Task',
    // Templates
    templatePresentation: 'Presentation',
    templateWebApp: 'Web App',
    templateMobileApp: 'Mobile App (Expo)',
    templateResearchBrief: 'Research Brief',
    templateTripPlan: 'Trip Plan',
    templateCodeAudit: 'Code Audit',
    templateMealPlan: 'Meal Plan',
    templateCliTool: 'CLI Tool',
  },

  // ── Task detail panel ───────────────────────────────────────
  taskDetail: {
    tabPlan: 'Plan',
    tabConsole: 'Console',
    tabDeliverable: 'Deliverable',
    tabWorkspace: 'Workspace',
    tabPreview: 'Preview',
    waitingForOutput: 'Waiting for output...',
    noOutput: 'No output',
    codeApp: 'Code App',
    mixed: 'Mixed',
    markdown: 'Markdown',
    starting: 'Starting...',
    start: 'Start',
    previewFailed: 'Preview failed',
    failedToStartPreview: 'Failed to start preview server',
    previewStopped: 'Preview server stopped unexpectedly',
    watchingForContent: 'Watching for content...',
    watchingForContentHint: 'Preview will appear as files are created',
    followUpPlaceholder: 'Ask a follow-up...',
    taskNotFound: 'Task not found',
    cancelTask: 'Cancel task',
    deleteTask: 'Delete task',
    phasesProgress: '{{done}}/{{total}} phases',
    approveAndExecute: 'Approve & Execute',
  },

  taskPlan: {
    writingPlan: 'Cerebro is writing your plan...',
    noPlan: 'No plan available',
    checkboxToggleFailed: 'Failed to update PLAN.md — please try again.',
  },

  // ── Routine editor ──────────────────────────────────────────
  routineEditor: {
    setSchedule: 'Set schedule',
    savingInProgress: 'Saving in progress...',
    noPromptSet: 'No prompt set',
    noTaskSet: 'No task set',
    noCategoriesDefined: 'No categories defined',
    noSchemaDefined: 'No schema defined',
    noQuerySet: 'No query set',
    noCommandSet: 'No command set',
    waitingForWebhook: 'Waiting for webhook',
    noItemsField: 'No items field',
    approvalCheckpoint: 'Approval checkpoint',
    noMessageSet: 'No message set',
    noTitleSet: 'No title set',
    never: 'Never',
    justNow: 'Just now',
    notifyOnCompletion: 'Notify on completion',
    notifyViaTelegram: 'via Telegram',
    notifyCount: '{{count}} via Telegram',
    notifyCount_one: '{{count}} via Telegram',
    notifyNoAllowlist: 'Connect Telegram in Integrations first, then add user IDs to the allowlist.',
    notifyHint: 'Pick one or more Telegram recipients. They will be DMed when this routine finishes or fails.',
    notifyClear: 'Clear notifications',
    notifyChannelTelegram: 'Telegram',
  },

  // ── Experts screen ──────────────────────────────────────────
  experts: {
    addExpert: 'Add Expert',
    newExpert: 'New Expert',
    filterAll: 'All',
    filterActive: 'Active',
    filterDisabled: 'Disabled',
    filterPinned: 'Pinned',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    resetView: 'Reset view',
    leadExpert: 'LEAD EXPERT',
    alwaysAvailable:
      'Always available. Plans, delegates, learns, and gets things done.',
    capabilities: 'CAPABILITIES',
    capResponds: 'Responds directly',
    capRoutes: 'Routes to experts',
    capRoutines: 'Proposes routines',
    capDrafts: 'Drafts specialists',
    capMemory: 'Manages memory',
    statusLabel: 'STATUS',
    expert_one: '{{count}} expert active',
    expert_other: '{{count}} experts active',
    pinned: '{{count}} pinned',
    nodeId: 'NODE ID',
    details: 'DETAILS',
    name: 'Name',
    domain: 'Domain',
    description: 'Description',
    avatar: 'Avatar',
    teamMembers: 'TEAM MEMBERS',
    configuration: 'Configuration',
    callExpert: 'Call expert',
    removeFromTeam: 'Remove from team',
    noMembersYet: 'No members yet.',
    noAvailableExperts: 'No available experts to add.',
    addMember: 'Add Member',
    skills: 'SKILLS',
    systemContext: 'SYSTEM CONTEXT',
    systemPromptPlaceholder: "Define this expert's behavior and personality...",
    settingsSection: 'SETTINGS',
    enabled: 'Enabled',
    pinnedLabel: 'Pinned',
    memorySection: 'MEMORY',
    infoSection: 'INFO',
    source: 'Source',
    type: 'Type',
    versionLabel: 'Version',
    lastActive: 'Last active',
    deleteExpert: 'Delete Expert',
    alwaysActive: 'Always Active',
    connected: 'Connected',
  },

  // ── Create expert dialog ────────────────────────────────────
  createExpert: {
    newExpert: 'New Expert',
    newTeam: 'New Team',
    typeLabel: 'Type',
    typeExpert: 'Expert',
    typeTeam: 'Team',
    namePlaceholderExpert: 'e.g. Research Analyst',
    namePlaceholderTeam: 'e.g. Research Division',
    descPlaceholderExpert: 'What does this expert do?',
    descPlaceholderTeam: 'What does this team handle?',
    membersSelected: '({{count}} selected)',
    membersEmpty:
      'Create individual experts first, then add them to a team.',
    createExpert: 'Create Expert',
    createTeam: 'Create Team',
  },

  // ── Expert detail panel time ago ────────────────────────────
  timeAgo: {
    never: 'Never',
    justNow: 'Just now',
    minutesAgo: '{{count}}m ago',
    hoursAgo: '{{count}}h ago',
    daysAgo: '{{count}}d ago',
  },

  // ── Domains ─────────────────────────────────────────────────
  domains: {
    productivity: 'Productivity',
    health: 'Health',
    finance: 'Finance',
    creative: 'Creative',
    engineering: 'Engineering',
    research: 'Research',
  },

  // ── Routines ────────────────────────────────────────────────
  routines: {
    title: 'Routines',
    total: '{{count}} total',
    active: '{{count}} active',
    newRoutine: 'New Routine',
    filterAll: 'All',
    filterEnabled: 'Enabled',
    filterScheduled: 'Scheduled',
    filterManual: 'Manual',
    noRoutinesYet: 'No routines yet',
    noRoutinesDescription:
      'Routines automate multi-step tasks. Create your first routine to get started.',
    createFirst: 'Create your first routine',
    noMatchSearch: 'No routines match your search.',
    noMatchFilter: 'No routines match your filter.',
    lastRun: 'Last run',
    runs: 'Runs',
    runNow: 'Run Now',
    deleteRoutine: 'Delete routine',
    deleteConfirm: 'Delete "{{name}}"? This cannot be undone.',
  },

  // ── Create routine dialog ───────────────────────────────────
  createRoutine: {
    title: 'New Routine',
    name: 'Name',
    namePlaceholder: 'e.g. Daily Standup Summary',
    description: 'Description',
    descPlaceholder: 'What does this routine do?',
    trigger: 'Trigger',
    triggerManualDesc: 'Run on demand',
    triggerScheduledDesc: 'Run on a schedule',
    triggerWebhookDesc: 'Run via webhook',
    schedule: 'Schedule',
    createRoutine: 'Create Routine',
  },

  // ── Activity screen ─────────────────────────────────────────
  activity: {
    title: 'Activity',
    total: '{{count}} total',
    noActivityYet: 'No activity yet',
    noActivityDescription:
      'Your activity timeline will show routine runs, delegations, and orchestrations as they happen.',
    startConversation: 'Start a conversation',
    noMatchFilters: 'No runs match your filters.',
    stepsProgress: '{{completed}}/{{total}} steps',
    awaitingApproval: 'Awaiting approval',
    runDetails: 'Run Details',
    run: 'Run',
    started: 'Started',
    finished: 'Finished',
    runNotFound: 'Run not found.',
    failedToLoadDetails: 'Failed to load run details.',
    tabSteps: 'Steps',
    tabEvents: 'Events',
    tabChildren: 'Children',
    today: 'Today, {{time}}',
    yesterday: 'Yesterday, {{time}}',
    loadMore: 'Load more ({{count}} remaining)',
    failedToLoad: 'Failed to load activity',
    filter: {
      all: 'All',
      running: 'Running',
      paused: 'Paused',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      routine: 'Routine',
      preview: 'Preview',
      ad_hoc: 'Ad-Hoc',
      orchestration: 'Orchestration',
      task: 'Task',
      manual: 'Manual',
      scheduled: 'Scheduled',
      chat: 'Chat',
      webhook: 'Webhook',
    },
  },

  // ── Approvals screen ────────────────────────────────────────
  approvals: {
    title: 'Approvals',
    subtitle: 'Review and approve pending actions',
    pendingTab: 'Pending',
    pendingTabCount: 'Pending ({{count}})',
    historyTab: 'History',
    noPending: 'No pending approvals',
    noPendingDescription:
      'When a routine step requires your sign-off, it will appear here.',
    noHistory: 'No approval history yet',
    noHistoryDescription: 'Resolved approvals will appear here.',
    parameters: 'Parameters',
    requested: 'Requested {{time}}',
    reason: 'Reason: ',
    resolved: 'Resolved {{time}}',
    reasonPlaceholder: 'Reason (optional)',
    confirm: 'Confirm',
    deny: 'Deny',
    approve: 'Approve',
  },

  // ── Integrations screen ─────────────────────────────────────
  integrations: {
    title: 'Integrations',
    engine: 'Engine',
    connectedApps: 'Connected Apps',
    channels: 'Channels',
    remoteAccess: 'Remote Access',
    remoteAccessDescription:
      "Enable inbound events and remote triggers to reach Cerebro when you're away.",
    remoteAccessComingSoon:
      'Outbound relay, webhook endpoints, and identity pairing will be available in a future release.',
  },

  // ── Engine section ──────────────────────────────────────────
  engineSection: {
    title: 'Engine',
    description:
      'Cerebro uses the Claude Code CLI as its inference engine. All experts, routines, and conversations are powered by Claude Code subagents.',
    claudeCode: 'Claude Code',
    claudeCodeDesc: "Anthropic's official CLI for Claude",
    detected: 'Detected',
    detecting: 'Detecting\u2026',
    notFound: 'Not found',
    error: 'Error',
    version: 'Version',
    path: 'Path',
    notFoundMessage:
      'Cerebro could not find the Claude Code CLI on your system.',
    notFoundError: '({{error}})',
    installGuide: 'Install it from',
    installGuideLink: 'the official setup guide',
    installGuideAfter: 'and click Re-detect once installed.',
    redetect: 'Re-detect',
  },

  // ── Connected apps section ──────────────────────────────────
  connectedApps: {
    title: 'Connected Apps',
    description:
      "Connect external services so Cerebro can read and write on your behalf. Web search is already available out of the box via Claude Code's built-in WebSearch tool.",
    googleCalendar: 'Google Calendar',
    googleCalendarDesc: 'Calendar events and scheduling',
    gmail: 'Gmail',
    gmailDesc: 'Read and send emails',
    notion: 'Notion',
    notionDesc: 'Pages, databases, and knowledge base',
    slack: 'Slack',
    slackDesc: 'Team messaging and notifications',
  },

  // ── Channels section ────────────────────────────────────────
  channelsSection: {
    title: 'Channels',
    description:
      'Connect messaging platforms to interact with Cerebro remotely.',
    telegram: 'Telegram',
    telegramDesc: 'Message Cerebro via Telegram bot',
    whatsapp: 'WhatsApp',
    whatsappDesc: 'Chat with Cerebro on WhatsApp',
    email: 'Email',
    emailDesc: 'Interact with Cerebro via email',
  },

  // ── Telegram section (within Channels) ──────────────────────
  telegramSection: {
    title: 'Telegram',
    description:
      'Chat with Cerebro from your phone. Cerebro listens via long-polling, so no public URL or tunnel is needed — the bridge runs inside Cerebro and stops when you quit the app.',
    tokenLabel: 'Bot token',
    tokenPlaceholder: 'Paste the token from @BotFather',
    verify: 'Verify',
    verifying: 'Verifying...',
    verified: 'Verified',
    allowlistLabel: 'Allowed user IDs',
    allowlistHelp: 'Only these Telegram user IDs can chat with the bot. Separate multiple IDs with commas.',
    allowlistPlaceholder: '123456789, 987654321',
    forwardAllLabel: 'Forward all approvals to Telegram',
    forwardAllHelp: 'Off by default: only approvals for runs started from Telegram are sent. Turn this on if you also want desktop-initiated approvals on your phone.',
    enableLabel: 'Enable bridge',
    enableDisabledHint: 'Verify the token and add at least one user ID to enable.',
    statusRunning: 'Running',
    statusStopped: 'Stopped',
    lastPoll: 'Last contact',
    lastError: 'Last error',
    never: 'never',
    howToTitle: 'How to get your Telegram user ID',
    howToSteps:
      '1. Open Telegram and find your bot by its username.\n2. Tap Start and send any message.\n3. The bot replies with a message containing your numeric ID.\n4. Paste that number into the allowlist above.',
    warningPlaintext:
      'Tokens are stored locally in your database in plaintext. If your machine is compromised, revoke the token with @BotFather and create a new one.',
    save: 'Save',
    saved: 'Saved',
  },

  // ── Skills library ──────────────────────────────────────────
  skills: {
    title: 'Skills Library',
    searchPlaceholder: 'Search skills...',
    newSkill: 'New Skill',
    filterAll: 'All',
    filterMine: 'Mine',
    loadingSkills: 'Loading skills...',
    noMatchingSkills: 'No matching skills.',
    noSkillsFound: 'No skills found.',
    emptyTitle: 'Skills Library',
    emptyDescription:
      'Skills are reusable capabilities you can assign to experts. Select a skill or add a new one.',
    importSkill: 'Import Skill',
    createManually: 'Create Manually',
    // Add skill dialog
    addSkill: 'Add Skill',
    importTab: 'Import',
    createTab: 'Create Manually',
    importDescription:
      'Import a skill from GitHub, skills.sh, or any URL that hosts a SKILL.md file.',
    importPlaceholder: 'Paste a URL, npx command, or owner/repo...',
    importFailed: 'Import failed',
    fetchingSkill: 'Fetching skill...',
    import: 'Import',
    importSuccess:
      'Imported successfully. Review the details below and save.',
    supportedFormats: 'SUPPORTED FORMATS',
    formatNpx: 'npx command',
    formatGithubShort: 'GitHub shorthand',
    formatGithubUrl: 'GitHub URL',
    formatSkillsSh: 'skills.sh',
    formatDirectUrl: 'Direct URL',
    // Form fields
    nameLabel: 'NAME',
    namePlaceholder: 'e.g. Financial Analysis, API Testing',
    categoryLabel: 'CATEGORY',
    iconLabel: 'ICON',
    descriptionLabel: 'DESCRIPTION',
    descriptionPlaceholder:
      'One sentence explaining what this skill teaches an expert to do.',
    instructionsLabel: 'INSTRUCTIONS',
    markdownSupported: 'Markdown supported',
    instructionsPlaceholder:
      "Write or paste the skill instructions here. This markdown gets injected into the expert's system prompt when this skill is assigned.",
    createSkill: 'Create Skill',
    // Detail view
    toolsLabel: 'TOOLS',
    assignedTo: 'ASSIGNED TO',
    notAssigned: 'Not assigned to any experts.',
    allExpertsHaveSkill: 'All experts already have this skill.',
    assignToExpert: 'Assign to Expert',
    builtInReadOnly: 'Built-in \u2014 read only',
    sourceVersion: '{{source}} \u00b7 v{{version}}',
    // Categories
    categoryAll: 'All Skills',
    categoryGeneral: 'General',
    categoryEngineering: 'Engineering',
    categoryContent: 'Content',
    categoryOperations: 'Operations',
    categorySupport: 'Support',
    categoryFinance: 'Finance',
    categoryFitness: 'Fitness',
    categoryProductivity: 'Productivity',
  },

  // ── Settings screen ─────────────────────────────────────────
  settings: {
    title: 'Settings',
    memory: 'Memory',
    sandbox: 'Sandbox',
    appearance: 'Appearance',
    about: 'About',
    aboutComingSoon: 'About Cerebro coming soon',
  },

  // ── Appearance section ──────────────────────────────────────
  appearance: {
    title: 'Appearance',
    description: 'Customize how Cerebro looks and behaves.',
    showHistoricalLogs: 'Show historical step logs',
    showHistoricalLogsDesc:
      'Display step-by-step logs when viewing past routine runs. Logs are always recorded \u2014 this controls whether they appear in the UI.',
    language: 'Language',
    languageDesc:
      'Choose the language for the Cerebro interface. AI responses will also adapt to your selected language.',
  },

  // ── Memory section ──────────────────────────────────────────
  memory: {
    title: 'Memory',
    description:
      'Each agent has its own memory directory. These markdown files are read by the agent at the start of every turn and edited as it learns.',
    agents: 'Agents',
    noAgentsYet: 'No agents yet.',
    files: 'Files',
    newFile: 'New file',
    newFilePlaceholder: 'notes.md',
    noFilesYet: 'No files yet.',
    selectFile: 'Select a file or create a new one.',
    selectAgent: 'Select an agent to view its memory.',
    lastUpdated: 'Last updated: {{time}}',
    editorPlaceholder:
      'Write markdown the agent should read on every turn...',
  },

  // ── Sandbox section ─────────────────────────────────────────
  sandbox: {
    title: 'Sandbox',
    description:
      "Restrict what Cerebro's agents can read and write on your Mac. The sandbox is a macOS Seatbelt profile wrapped around the Claude Code subprocess \u2014 denied operations fail with a permission error instead of touching your files.",
    enableSandbox: 'Enable sandbox',
    macOsOnly: 'macOS only (v1)',
    activeDesc:
      'Agents can only touch the workspace and linked projects.',
    inactiveDesc: 'Agents have unrestricted access to your files.',
    disableSandbox: 'Disable sandbox',
    disableConfirmTitle: 'Disable sandbox?',
    disableConfirmDesc:
      'Every agent run after this point will have full access to your home directory and every file you can read or write.',
    yesDisable: 'Yes, disable',
    keepEnabled: 'Keep enabled',
    workspace: 'Workspace',
    cerebroWorkspace: 'Cerebro workspace',
    openInFinder: 'Open in Finder',
    workspaceDescription:
      'Always read-write. Agents default to this directory when they just need a scratch space. Your existing projects live elsewhere \u2014 link them below.',
    linkedProjects: 'Linked projects',
    linkProject: 'Link Project',
    noProjectsLinked:
      'No projects linked yet. Click Link Project to grant Cerebro access to a specific directory \u2014 for example ~/Desktop/projects/my-repo.',
    newLinksReadOnly:
      'New links default to Read-Only. Promote to Read-Write per project when you want agents to actually make changes.',
    readWrite: 'Read-Write',
    readOnly: 'Read-Only',
    allowWrites: 'Allow writes',
    makeReadOnly: 'Make read-only',
    promoteToReadWrite: 'Promote to Read-Write',
    revertToReadOnly: 'Revert to Read-Only',
    unlinkProject: 'Unlink project',
    confirmWriteTitle:
      'Allow Cerebro to write into this directory?',
    confirmWriteDesc:
      'Agents will be able to create, modify, and delete files under {{path}}.',
    yesAllowWrites: 'Yes, allow writes',
    alwaysBlocked: 'Always blocked',
    blockedDescription:
      'These paths are denied regardless of any links you add. Cerebro will refuse to link a directory inside them at all.',
    viewSeatbeltProfile: 'View effective Seatbelt profile',
    cerebroDataDir: "Cerebro's own data directory",
  },

  // ── Placeholder screen ──────────────────────────────────────
  placeholder: {
    experts:
      'Specialized agents that handle tasks in specific domains. Cerebro routes your requests to the right expert.',
    routines:
      'Reusable, executable playbooks. Create them from chat or browse saved routines here.',
    activity:
      'Timeline of all runs \u2014 see logs, outputs, timestamps, and drill into any execution.',
    approvals:
      'Review and approve or deny pending actions that require your sign-off before executing.',
    marketplace:
      'Browse and install expert packs, action packs, and routine templates.',
  },

  // ── Voice / call ────────────────────────────────────────────
  call: {
    modelsNotFound: 'Voice Models Not Found',
    modelsNotInstalledPre:
      "Voice models are not installed. If you're running from source, run the download script first:",
    modelsNotInstalledPost:
      'This downloads the Kokoro TTS model (~340 MB) to the voice-models/ directory. Whisper STT auto-downloads on first use. Production builds bundle these automatically.',
    goBack: 'Go Back',
    holdToTalk: 'Hold to talk (Space)',
    endCall: 'End Call (Esc)',
    hideCaptions: 'Hide captions',
    showCaptions: 'Show captions',
    you: 'You:',
  },

  // ── Alert modal ─────────────────────────────────────────────
  alert: {
    defaultAction: 'Got it',
  },
} as const;

export type TranslationKeys = typeof en;
export default en;
