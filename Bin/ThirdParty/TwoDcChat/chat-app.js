/**
 * COMOS Engineering Assistant - Chat Application
 * 
 * This file contains all JavaScript logic for the chat widget application.
 * 
 * ARCHITECTURE:
 * - Constants: Message types, default strings, Logger utility
 * - Utilities: Helper functions and CefSharp detection
 * - Application State: Centralized state management
 * - C# Interop: Backend communication layer
 * - Event Handlers: Widget event handling
 * - Widget Configuration: Builders and initialization
 * - Widget Operations: Message and conversation management
 * - Application Lifecycle: Initialization and setup
 * - C# Public Interface: Functions exposed to C# via window object
 */

//#region CONSTANTS

/** Message types for C# backend communication */
const MESSAGE_TYPES = {
    CONVERSATION_CREATE: 'conversationCreate',
    CONVERSATION_SWITCH: 'conversationSwitch',
    USER_MESSAGE: 'userMessage'
};

/** Default messages and strings */
const DEFAULT_MESSAGES = {
    PROCESSING: 'Processing your request...',
    DEBUG_PREFIX: 'Debug mode: CefSharp not available. Your message was:',
    DEFAULT_CONVERSATION_TITLE: 'New Conversation',
    WIDGET_NOT_FOUND: 'Chat widget library not found',
    WIDGET_LOAD_ERROR: 'Chat widget library not loaded! Check if chat-widget.js exists.',
    APP_INIT_ERROR: 'Application initialization failed:',
    WIDGET_NOT_INITIALIZED: 'Widget not initialized',
    INVALID_CONVERSATIONS: 'Invalid conversations array',
    NOT_IMPLEMENTED: 'setFollowupPrompts is currently not implemented in the widget.',
    PDF_ONLY_ALLOWED: 'Only PDF attachments are supported.',
    ATTACHMENT_READ_ERROR: 'Could not read one or more attachments. Please try again.'
};

const PDF_MIME_TYPE = 'application/pdf';

/** Logging utility with different log levels */
const Logger = {
    info: (message, data = null) => {
        console.log(`[Chat Widget - INFO] ${message}`, data !== null ? data : '');
    },
    warn: (message, data = null) => {
        console.warn(`[Chat Widget - WARN] ${message}`, data !== null ? data : '');
    },
    error: (message, data = null) => {
        console.error(`[Chat Widget - ERROR] ${message}`, data !== null ? data : '');
    },
    debug: (message, data = null) => {
        console.log(`[Chat Widget] ${message}`, data !== null ? data : '');
    }
};

//#endregion CONSTANTS

//#region UTILITIES & HELPERS

/** Checks if CefSharp is available for C# interop */
function isCefSharpAvailable() {
    return typeof CefSharp !== 'undefined';
}

/**
 * Normalizes dropped files into a standard array.
 * @param {Array|FileList|null|undefined} droppedFiles
 * @returns {Array<File>}
 */
function normalizeDroppedFiles(droppedFiles) {
    if (!droppedFiles) {
        return [];
    }

    if (Array.isArray(droppedFiles)) {
        return droppedFiles;
    }

    if (typeof droppedFiles.length === 'number') {
        return Array.from(droppedFiles);
    }

    return [];
}

/**
 * Checks if a file is a PDF by mime type or extension.
 * @param {File} file
 * @returns {boolean}
 */
function isPdfFile(file) {
    if (!file || !file.name) {
        return false;
    }

    const fileName = file.name.toLowerCase();
    return file.type === PDF_MIME_TYPE || fileName.endsWith('.pdf');
}

/**
 * Reads a browser File object and returns base64 content without data-url prefix.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            const rawResult = reader.result;
            if (typeof rawResult !== 'string') {
                reject(new Error('Invalid file reader result'));
                return;
            }

            const separatorIndex = rawResult.indexOf(',');
            resolve(separatorIndex >= 0 ? rawResult.slice(separatorIndex + 1) : rawResult);
        };

        reader.onerror = () => {
            reject(new Error('File read failed'));
        };

        reader.readAsDataURL(file);
    });
}

/**
 * Converts dropped files to PDF attachment payload objects.
 * @param {Array|FileList|null|undefined} droppedFiles
 * @returns {Promise<{ attachments: Array<Object>, ignoredFileNames: Array<string>, readErrors: Array<string> }>}
 */
async function buildPdfAttachments(droppedFiles) {
    const files = normalizeDroppedFiles(droppedFiles);
    const pdfFiles = files.filter(isPdfFile);
    const ignoredFileNames = files
        .filter(file => !isPdfFile(file))
        .map(file => (file && file.name) ? file.name : 'unknown-file');
    const attachments = [];
    const readErrors = [];

    for (const file of pdfFiles) {
        try {
            const contentBase64 = await readFileAsBase64(file);
            attachments.push({
                fileName: file.name,
                mimeType: file.type || PDF_MIME_TYPE,
                sizeBytes: file.size,
                contentBase64
            });
        } catch (error) {
            Logger.error('Failed to read PDF attachment', { fileName: (file && file.name) ? file.name : 'unknown-file', error: (error && error.message) ? error.message : error });
            readErrors.push((file && file.name) ? file.name : 'unknown-file');
        }
    }

    return { attachments, ignoredFileNames, readErrors };
}

//#endregion UTILITIES & HELPERS

//#region APPLICATION STATE

/** Application state - manages conversation and widget instances */
const appState = {
    conversationState: {
        currentConversationId: null
    },
    widgetInstance: null
};

//#endregion APPLICATION STATE

//#region C# INTEROP BRIDGE

/**
 * Sends message to C# backend via CefSharp
 * @param {Object} payload - Message payload
 * @returns {boolean} Success status
 */
function sendToBackend(payload) {
    if (!isCefSharpAvailable()) {
        Logger.debug('CefSharp not available - cannot send message to backend', payload);
        return false;
    }

    try {
        CefSharp.PostMessage(payload);
        Logger.debug('Message sent to C# backend', payload);
        return true;
    } catch (error) {
        Logger.debug('Error sending message to backend:', error.message);
        return false;
    }
}

/** Notifies C# about a new conversation creation */
function notifyConversationCreate() {
    sendToBackend({ type: MESSAGE_TYPES.CONVERSATION_CREATE });
}

/**
 * Notifies C# about conversation switch
 * @param {string} conversationId - Conversation ID
 */
function notifyConversationSwitch(conversationId) {
    sendToBackend({
        type: MESSAGE_TYPES.CONVERSATION_SWITCH,
        conversationId
    });
}

/**
 * Sends user message to C# backend
 * @param {string} message - User message
 * @param {string} conversationId - Conversation ID
 * @param {Array|FileList|null|undefined} droppedFiles - Attached files from UI
 * @returns {Promise<string>} Placeholder message
 */
async function sendUserMessage(message, conversationId, droppedFiles) {
    const { attachments, ignoredFileNames, readErrors } = await buildPdfAttachments(droppedFiles);

    if (ignoredFileNames.length > 0 && attachments.length === 0) {
        Logger.warn('User attached unsupported files only', { ignoredFileNames });
        return `${DEFAULT_MESSAGES.PDF_ONLY_ALLOWED} Ignored: ${ignoredFileNames.join(', ')}`;
    }

    if (readErrors.length > 0 && attachments.length === 0) {
        return DEFAULT_MESSAGES.ATTACHMENT_READ_ERROR;
    }

    // ── PDF Attachment: pre-load into shim, then send text via CefSharp ─
    // CefSharp.PostMessage → C# Ai Client strips the attachments array,
    // so the shim never sees the PDF.  We work around this by:
    //   1. POST the PDF directly to the shim's /api/ai/v1/attach-pdf
    //      (stores it in the shim's pendingPdfs map under "__default__")
    //   2. Send the text-only message through normal CefSharp → C# path
    //      (the shim finds the stored PDF and starts the digitization flow)
    if (attachments.length > 0) {
        Logger.info('PDF attachment detected — pre-loading to shim', {
            count: attachments.length,
            names: attachments.map(function (a) { return a.fileName; })
        });

        var shimBase = _detectShimBase();
        var att = attachments[0]; // Use first PDF

        try {
            var uploadResp = await fetch(shimBase + '/api/ai/v1/attach-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    attachment: att,
                    message: message
                })
            });

            if (!uploadResp.ok) {
                Logger.error('Shim attach-pdf failed', uploadResp.status);
                return 'Could not upload PDF. Please try pasting the file path instead.';
            }

            var uploadData = await uploadResp.json();
            Logger.info('PDF pre-loaded to shim', uploadData.filename);
        } catch (err) {
            Logger.error('Direct shim attach-pdf failed', err.message);
            return 'Could not upload PDF. Please try pasting the file path instead.';
        }

        // Now send the text message through CefSharp — the shim will
        // find the pre-loaded PDF and proceed with digitization
        var sent = sendToBackend({
            type: MESSAGE_TYPES.USER_MESSAGE,
            content: message,
            conversationId
            // attachments omitted — already pre-loaded via attach-pdf
        });

        if (!sent) {
            return 'Could not upload PDF. Please try pasting the file path instead.';
        }

        return DEFAULT_MESSAGES.PROCESSING;
    }

    // ── No attachment: normal CefSharp path ─────────────────────────────
    const success = sendToBackend({
        type: MESSAGE_TYPES.USER_MESSAGE,
        content: message,
        conversationId,
        attachments
    });

    if (success) {
        if (ignoredFileNames.length > 0) {
            Logger.warn('Ignored non-PDF attachments', { ignoredFileNames });
            return `${DEFAULT_MESSAGES.PROCESSING} ${DEFAULT_MESSAGES.PDF_ONLY_ALLOWED} Ignored: ${ignoredFileNames.join(', ')}`;
        }

        if (readErrors.length > 0) {
            return `${DEFAULT_MESSAGES.PROCESSING} ${DEFAULT_MESSAGES.ATTACHMENT_READ_ERROR}`;
        }

        return DEFAULT_MESSAGES.PROCESSING;
    } else {
        Logger.debug('CefSharp not available - debug mode');
        return `${DEFAULT_MESSAGES.DEBUG_PREFIX} ${message}`;
    }
}

/**
 * Detects the AI shim base URL from download links in the page,
 * or falls back to the default port.
 * @returns {string} e.g. "http://127.0.0.1:56401"
 */
function _detectShimBase() {
    // Try to find an existing download link that contains the shim port
    var links = document.querySelectorAll('a[href*="/comos/download/"]');
    for (var i = 0; i < links.length; i++) {
        var m = links[i].href.match(/(https?:\/\/[^/]+)\/comos\/download\//);
        if (m) return m[1];
    }
    // Default shim port
    return 'http://127.0.0.1:56401';
}

//#endregion C# INTEROP BRIDGE

//#region WIDGET EVENT HANDLERS & CONFIGURATION

//#region Event Handlers

/** Handles conversation creation event */
function handleConversationCreate() {
    notifyConversationCreate();
}

/**
 * Handles conversation switch event
 * @param {string} conversationId - Conversation ID
 * @param {Object} conversationState - Conversation state object
 */
function handleConversationSwitch(conversationId, conversationState) {
    if (conversationId) {
        conversationState.currentConversationId = conversationId;
        notifyConversationSwitch(conversationId);
    }
}

//#endregion Event Handlers

//#region Validation & User Interaction

/** Validates that the widget library is loaded */
function validateWidgetLibrary() {
    if (typeof window.TwodcChatUI === 'undefined') {
        const error = DEFAULT_MESSAGES.WIDGET_NOT_FOUND;
        Logger.error('ERROR:', error);
        alert(DEFAULT_MESSAGES.WIDGET_LOAD_ERROR);
        throw new Error(error);
    }
}

/**
 * Handles user confirmation requests
 * @param {string} msg - Confirmation message
 * @returns {Promise<boolean>} User response
 */
async function handleUserConfirmation(msg) {
    Logger.debug('getUserConfirmation called:', msg);
    return confirm(msg);
}

//#endregion Validation & User Interaction

//#region Message Handling
/**
 * Handles message submission from widget
 * @param {string} message - User message
 * @param {Array|FileList|null|undefined} droppedFiles - Files dropped/attached by user
 * @param {Object} context - Message context with conversationId
 * @param {Object} conversationState - Conversation state object
 * @returns {Promise<string>} Response message
 */
async function handleMessage(message, droppedFiles, context, conversationState) {
    Logger.debug('User message:', message);

    // Update stored conversation ID from context
    const conversationId = context && context.conversationId ? context.conversationId : null;
    if (conversationId && conversationId !== conversationState.currentConversationId) {
        conversationState.currentConversationId = conversationId;
        Logger.debug("New conversation started with message:", message);
    }

    // If a PDF was attached via the + button, include it as a dropped file
    let effectiveDroppedFiles = droppedFiles;
    if (window._pendingPdfFile) {
        const pendingFile = window._pendingPdfFile;
        window._pendingPdfFile = null;
        Logger.info('Including pending PDF from + button', pendingFile.name);
        const existing = normalizeDroppedFiles(droppedFiles);
        effectiveDroppedFiles = [...existing, pendingFile];
    }

    // Send message to C# backend
    return sendUserMessage(message, conversationId, effectiveDroppedFiles);
}

//#endregion Message Handling

//#region Configuration Builders

/** Builds the widget configuration object */
function buildWidgetConfig() {
    return {
        title: 'COMOS Engineering Copilot',
        features: {
            conversationSidebar: true,
            messageSearch: false,
            fileUpload: true,
            voiceInput: true
        }
    };
}

/**
 * Builds event handlers for widget
 * @param {Object} conversationState - Conversation state object
 * @returns {Object} Event handlers
 */
function buildEventHandlers(conversationState) {
    return {
        onConversationCreate: () => {
            handleConversationCreate();
        },

        onConversationSwitch: (conversationId, conversation) => {
            handleConversationSwitch(conversationId, conversationState);
        },

        onReady: () => {
            Logger.debug('Widget ready');
        },

        onInit: () => {
            Logger.debug('Widget initialized');
        }
    };
}

//#endregion Configuration Builders

//#region Widget Initialization

/**
 * Creates and initializes the chat widget
 * @param {Object} options - Configuration options
 * @param {string} options.containerId - Container element selector
 * @param {Object} options.conversationState - Conversation state object
 * @returns {Promise<Object>} Widget instance
 */
async function createWidget(options) {
    const { containerId, conversationState } = options;

    // Validate widget library is loaded
    validateWidgetLibrary();

    Logger.debug('Initializing chat widget...');

    // Create widget with configuration
    const widget = await window.TwodcChatUI.createChatWidget({
        container: containerId,
        getUserConfirmation: handleUserConfirmation,
        onMessage: (message, droppedFiles, context) => 
            handleMessage(message, droppedFiles, context, conversationState),
        config: buildWidgetConfig(),
        events: buildEventHandlers(conversationState)
    });

    Logger.debug('Widget created successfully');
    return widget;
}

//#endregion Widget Initialization

//#endregion WIDGET EVENT HANDLERS & CONFIGURATION

//#region WIDGET OPERATIONS

/**
 * Adds assistant message to conversation
 * @param {Object} widget - Widget instance
 * @param {string} conversationId - Conversation ID
 * @param {string} message - Message content
 */
function addAssistantMessageToWidget(widget, conversationId, message) {
    if (!widget) {
        return;
    }

    try {
        if (widget.addMessageToConversation) {
            widget.addMessageToConversation(conversationId, 'assistant', message);
        }
    } catch (error) {
        Logger.error('Error adding assistant message:', error.message);
    }
}

/**
 * Sets typing indicator with custom status message
 * @param {string} message - Status message
 * @returns {boolean} Success status
 */
function _setProcessingStatus(message) {
    if (!appState.widgetInstance) {
        Logger.error('Widget not initialized - cannot set processing status');
        return false;
    }

    try {
        if (appState.widgetInstance.setTyping) {
            appState.widgetInstance.setTyping(true, message);
            Logger.debug('âœ“ Processing status set:', message);
            return true;
        } else {
            Logger.error('widget.setTyping method not available');
            return false;
        }
    } catch (error) {
        Logger.error('Failed to set processing status:', error.message);
        return false;
    }
}

/** Clears typing indicator and status message */
function _clearProcessingStatus() {
    if (!appState.widgetInstance) {
        Logger.error('Widget not initialized - cannot clear processing status');
        return false;
    }

    try {
        if (appState.widgetInstance.setTyping) {
            appState.widgetInstance.setTyping(false);
            Logger.debug('âœ“ Processing status cleared');
            return true;
        } else {
            Logger.error('widget.setTyping method not available');
            return false;
        }
    } catch (error) {
        Logger.error('Failed to clear processing status:', error.message);
        return false;
    }
}

/**
 * Creates new conversation in widget
 * @param {Object} widget - Widget instance
 * @param {string} conversationId - Conversation ID
 * @param {string} title - Conversation title
 * @param {Object} conversationState - Conversation state object
 * @returns {string} Created conversation ID
 */
function createConversationInWidget(widget, conversationId, title, conversationState) {
    if (!widget) {
        const error = DEFAULT_MESSAGES.WIDGET_NOT_INITIALIZED;
        Logger.error(error);
        throw new Error(error);
    }

    // Store the conversation ID from C# for consistency
    conversationState.currentConversationId = conversationId;
    Logger.debug(`New conversation created: ${conversationId}`);

    try {
        const conversation = widget.createConversation(conversationId, title || DEFAULT_MESSAGES.DEFAULT_CONVERSATION_TITLE);
        Logger.debug(JSON.stringify(conversation));

        // Ensure our stored ID matches what was actually created
        if (conversation && conversation.id) {
            conversationState.currentConversationId = conversation.id;
        }

        return conversation ? conversation.id : conversationId;
    } catch (error) {
        Logger.error('Error creating conversation:', error.message);
        return null;
    }
}

//#endregion WIDGET OPERATIONS

//#region APPLICATION LIFECYCLE

/** Initializes the chat widget application */
async function initializeApp() {
    try {
        // Check CefSharp availability
        if (!isCefSharpAvailable()) {
            Logger.warn('CefSharp not detected - debug mode');
        }

        // Create and initialize the widget
        const widget = await createWidget({
            containerId: '#chat-widget',
            conversationState: appState.conversationState
        });

        // Store widget instance globally for C# integration and internal use
        appState.widgetInstance = widget;
        window.widget = widget;

        Logger.info('Application initialized successfully');
    } catch (error) {
        Logger.error('Application initialization failed:', error.message);
        alert(`${DEFAULT_MESSAGES.APP_INIT_ERROR} ${error.message}`);
    }
}

//#endregion APPLICATION LIFECYCLE

//#region C# PUBLIC INTERFACE
// Functions exposed to C# via the window object
// These form the contract between JavaScript and C# - DO NOT modify signatures

/** Sets up functions for C# to call via window object */
function setupCSharpInterface() {
    /**
     * Sets processing status message (called from C#)
     * Displays a custom message to the user while the request is being processed
     * @param {string} message - Status message describing current activity
     */
    window.setProcessingStatus = function (message) {
        _setProcessingStatus(message);
    };

    /** Clears processing status (called from C#) */
    window.clearProcessingStatus = function () {
        _clearProcessingStatus();
    };

    /**
     * Adds assistant message to conversation (called from C#)
     * @param {string} conversationId - Conversation ID
     * @param {string} message - Message content
     */
    window.addAssistantMessage = function (conversationId, message) {
        // Hide typing indicator when response arrives
        _clearProcessingStatus();
        
        const targetConversationId = conversationId || appState.conversationState.currentConversationId;
        addAssistantMessageToWidget(appState.widgetInstance, targetConversationId, message);
    };

    /**
     * Creates new conversation (called from C#)
     * @param {string} conversationId - Conversation ID
     * @param {string} title - Conversation title
     * @returns {string|null} Created conversation ID
     */
    window.createNewConversation = function (conversationId, title) {
        return createConversationInWidget(
            appState.widgetInstance,
            conversationId,
            title,
            appState.conversationState
        );
    };

    /**
     * Updates conversation title (called from C#)
     * @param {string} conversationId - Conversation ID
     * @param {string} title - New title
     */
    window.updateConversationTitle = function (conversationId, title) {
        if (!appState.widgetInstance) {
            Logger.error(DEFAULT_MESSAGES.WIDGET_NOT_INITIALIZED);
            return;
        }
        if (!conversationId || !title) {
            Logger.error('Invalid parameters for updateConversationTitle');
            return;
        }
        appState.widgetInstance.updateConversationTitle(conversationId, title);
    };

    /**
     * Sets follow-up prompts (called from C#)
     * @param {string} conversationId - Conversation ID
     * @param {Array<string>} prompts - Follow-up prompts
     */
    window.setFollowupPrompts = function (conversationId, prompts) {
        if (!appState.widgetInstance) {
            Logger.error(DEFAULT_MESSAGES.WIDGET_NOT_INITIALIZED);
            return;
        }
        Logger.warn(DEFAULT_MESSAGES.NOT_IMPLEMENTED);
        // appState.widgetInstance.setFollowupPrompts(conversationId, prompts);
    };

    /**
     * Loads earlier conversations (called from C#)
     * @param {Array<Object>} conversations - Conversation objects { id, title }
     */
    window.loadConversations = function (conversations) {
        if (!appState.widgetInstance) {
            Logger.error(DEFAULT_MESSAGES.WIDGET_NOT_INITIALIZED);
            return;
        }
        if (!Array.isArray(conversations)) {
            Logger.error(DEFAULT_MESSAGES.INVALID_CONVERSATIONS);
            return;
        }
        if (conversations.length === 0) {
            Logger.warn('Empty conversations array provided');
            return;
        }
        appState.widgetInstance.setOldConversations(conversations);
        Logger.info('Loaded conversation history', conversations);
    };
}

/** Application initialization when DOM is ready */
document.addEventListener('DOMContentLoaded', function () {
    // Set up C# interface functions
    setupCSharpInterface();

    // Initialize the application
    initializeApp();

    // Wire up the "+" file upload button in the widget
    setupFileUploadButton();

    // Intercept link clicks & inject interactive tables for analysis results
    setupDownloadLinkInterceptor();
    setupConfidenceTableInjector();
    setupScriptBlockHandler();
});

//#endregion C# PUBLIC INTERFACE

//#region DOWNLOAD LINK INTERCEPTOR

/**
 * Intercepts clicks on Excel download links rendered by react-markdown.
 * Without this, clicking an <a href="http://localhost:8100/comos/download/...">
 * in CefSharp would navigate the embedded browser away from the chat UI.
 * Instead, we fetch the file as a blob and trigger a proper download.
 */
function setupDownloadLinkInterceptor() {
    document.addEventListener('click', async function (e) {
        const link = e.target.closest('a');
        if (!link) return;

        const href = link.href;
        if (!href || !href.includes('/comos/download/')) return;

        e.preventDefault();
        e.stopPropagation();

        Logger.info('Intercepted download link click — sending to shim for save-to-disk', href);

        // Show downloading feedback
        var originalText = link.textContent;
        link.textContent = '⏳ Saving...';

        try {
            // CefSharp has no download handler, so blob/anchor.click() won't work.
            // Instead, ask the shim to download the file and save it to disk.
            var shimBase = _detectShimBase();
            var response = await fetch(shimBase + '/api/ai/v1/save-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: href })
            });

            if (!response.ok) throw new Error('HTTP ' + response.status);

            var result = await response.json();
            if (result.status === 'saved') {
                link.textContent = '✅ Saved: ' + result.filename;
                link.title = result.path;
                Logger.info('File saved to disk', result.path);
                // Show a brief notification with the full path
                var note = document.createElement('div');
                note.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#27ae60;color:#fff;padding:12px 20px;border-radius:8px;z-index:99999;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:500px;word-break:break-all;';
                note.textContent = '📁 Saved to: ' + result.path;
                document.body.appendChild(note);
                setTimeout(function () {
                    try { document.body.removeChild(note); } catch (_) {}
                }, 6000);
            } else {
                throw new Error(result.error || 'Unknown error');
            }

            setTimeout(function () { link.textContent = originalText; }, 8000);
        } catch (err) {
            Logger.error('Save-to-disk download failed', err.message);
            link.textContent = '❌ Download failed: ' + err.message;
            setTimeout(function () { link.textContent = originalText; }, 6000);
        }
    }, true); // Use capture phase to intercept before react-markdown handlers

    Logger.info('Download link interceptor installed');
}

//#endregion DOWNLOAD LINK INTERCEPTOR

//#region CONFIDENCE TABLE INJECTOR

/**
 * Global store for user's SystemFullName selections per analysis.
 * Key: analysis timestamp, Value: { items: [{tag, selectedSystemFullName, ...}] }
 */
window._analysisSelections = {};

/**
 * CSS for the confidence / alternatives table.
 * Injected once at init.
 */
function injectConfidenceTableStyles() {
    if (document.getElementById('comos-confidence-styles')) return;
    const style = document.createElement('style');
    style.id = 'comos-confidence-styles';
    style.textContent = [
        '.comos-confidence-table { width:100%; border-collapse:collapse; margin:8px 0; font-size:13px; }',
        '.comos-confidence-table th { background:#1b3a5c; color:#fff; padding:6px 8px; text-align:left; font-weight:600; white-space:nowrap; }',
        '.comos-confidence-table td { padding:5px 8px; border-bottom:1px solid #e0e0e0; vertical-align:middle; }',
        '.comos-confidence-table tr:nth-child(even) { background:#f5f7fa; }',
        '.comos-confidence-table tr:hover { background:#e8edf3; }',
        '.comos-confidence-table select { width:100%; padding:4px 6px; border:1px solid #bbb; border-radius:4px; background:#fff; font-size:12px; cursor:pointer; }',
        '.comos-confidence-table select:focus { border-color:#1b3a5c; outline:none; box-shadow:0 0 0 2px rgba(27,58,92,.2); }',
        '.comos-confidence-badge { display:inline-block; padding:2px 6px; border-radius:10px; font-size:11px; font-weight:600; margin-left:4px; }',
        '.comos-confidence-high { background:#d4edda; color:#155724; }',
        '.comos-confidence-mid  { background:#fff3cd; color:#856404; }',
        '.comos-confidence-low  { background:#f8d7da; color:#721c24; }',
        '.comos-table-container { background:#fff; border:1px solid #d0d5dd; border-radius:6px; padding:8px; margin:8px 0 4px 0; overflow-x:auto; }',
        '.comos-table-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }',
        '.comos-table-title { font-weight:600; font-size:14px; color:#1b3a5c; }',
        '.comos-export-btn { padding:5px 14px; background:#1b3a5c; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:12px; }',
        '.comos-export-btn:hover { background:#264d73; }',
        '.comos-export-btn:disabled { background:#999; cursor:not-allowed; }',
    ].join('\n');
    document.head.appendChild(style);
}

/**
 * Returns CSS class for a given confidence value (0-1 scale).
 */
function confidenceBadgeClass(conf) {
    if (conf >= 0.75) return 'comos-confidence-high';
    if (conf >= 0.50) return 'comos-confidence-mid';
    return 'comos-confidence-low';
}

/**
 * Build an interactive HTML confidence table from alternatives data.
 * @param {Array} items - Items with alternatives from analysis
 * @param {string} analysisId - Unique ID for this analysis
 * @param {string} excelUrl - URL for re-exporting Excel with selections
 * @returns {HTMLElement}
 */
function buildConfidenceTable(items, analysisId, excelUrl) {
    // Initialize selections store for this analysis
    window._analysisSelections[analysisId] = { items: [], excelUrl: excelUrl };

    const container = document.createElement('div');
    container.className = 'comos-table-container';
    container.dataset.analysisId = analysisId;

    // Header
    const header = document.createElement('div');
    header.className = 'comos-table-header';
    header.innerHTML =
        '<span class="comos-table-title">\uD83D\uDCCA Equipment Mapping — Select SystemFullName</span>' +
        '<button class="comos-export-btn" data-analysis-id="' + analysisId + '" title="Re-export Excel with your selections">' +
        '\uD83D\uDCE5 Export with Selections</button>';
    container.appendChild(header);

    // Table
    const table = document.createElement('table');
    table.className = 'comos-confidence-table';

    // Thead
    const thead = document.createElement('thead');
    thead.innerHTML =
        '<tr>' +
        '<th>#</th>' +
        '<th>Tag</th>' +
        '<th>Description</th>' +
        '<th>SystemFullName</th>' +
        '<th>Conf.</th>' +
        '<th>Type</th>' +
        '</tr>';
    table.appendChild(thead);

    // Tbody
    const tbody = document.createElement('tbody');

    items.forEach(function (item, idx) {
        const tr = document.createElement('tr');

        const tag = item.tag || item.TAG || '';
        const desc = item.descricao || item.Descricao || item.description || '';
        const sfn = item.SystemFullName || '';
        const conf = item.Confiança || item.Confianca || 0;
        const tipo = item.Tipo_ref || item.type || '';
        const alts = item.alternatives || [];

        // Store default selection
        window._analysisSelections[analysisId].items.push({
            index: idx,
            tag: tag,
            selectedSystemFullName: sfn,
            selectedConf: conf,
            selectedType: tipo
        });

        // # column
        const tdNum = document.createElement('td');
        tdNum.textContent = String(idx + 1);
        tr.appendChild(tdNum);

        // Tag column
        const tdTag = document.createElement('td');
        tdTag.textContent = tag;
        tdTag.style.fontFamily = 'monospace';
        tr.appendChild(tdTag);

        // Description column
        const tdDesc = document.createElement('td');
        tdDesc.textContent = desc.length > 40 ? desc.substring(0, 37) + '...' : desc;
        tdDesc.title = desc;
        tr.appendChild(tdDesc);

        // SystemFullName dropdown column
        const tdSfn = document.createElement('td');
        if (alts.length > 1) {
            const select = document.createElement('select');
            select.dataset.itemIndex = String(idx);
            select.dataset.analysisId = analysisId;

            alts.forEach(function (alt, altIdx) {
                const option = document.createElement('option');
                const altSfn = alt.SystemFullName || '';
                const altConf = alt.Confiança || alt.Confianca || 0;
                const altType = alt.Tipo_ref || '';
                const altDesc = alt.Descricao_ref || '';
                const pct = (altConf * 100).toFixed(1);
                option.value = altIdx;
                option.textContent = altSfn + ' (' + pct + '%)';
                option.title = altType + ' — ' + altDesc;
                if (altSfn === sfn) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', function () {
                const selIdx = parseInt(select.value, 10);
                const chosen = alts[selIdx];
                if (!chosen) return;
                // Update selection store
                var sel = window._analysisSelections[analysisId].items[idx];
                sel.selectedSystemFullName = chosen.SystemFullName || '';
                sel.selectedConf = chosen.Confiança || chosen.Confianca || 0;
                sel.selectedType = chosen.Tipo_ref || '';
                // Update confidence badge
                var badge = tr.querySelector('.comos-confidence-badge');
                if (badge) {
                    var pctNew = (sel.selectedConf * 100).toFixed(1);
                    badge.textContent = pctNew + '%';
                    badge.className = 'comos-confidence-badge ' + confidenceBadgeClass(sel.selectedConf);
                }
                Logger.debug('Selection changed: item ' + idx + ' → ' + sel.selectedSystemFullName);
            });

            tdSfn.appendChild(select);
        } else {
            tdSfn.textContent = sfn;
        }
        tr.appendChild(tdSfn);

        // Confidence badge column
        const tdConf = document.createElement('td');
        const confPct = (conf * 100).toFixed(1);
        tdConf.innerHTML = '<span class="comos-confidence-badge ' + confidenceBadgeClass(conf) + '">' + confPct + '%</span>';
        tr.appendChild(tdConf);

        // Type column
        const tdType = document.createElement('td');
        tdType.textContent = tipo;
        tr.appendChild(tdType);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);

    // Wire export button
    const exportBtn = container.querySelector('.comos-export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', function () {
            handleExportWithSelections(analysisId);
        });
    }

    return container;
}

/**
 * Re-export Excel with user's dropdown selections applied.
 */
function handleExportWithSelections(analysisId) {
    var analysis = window._analysisSelections[analysisId];
    if (!analysis) {
        Logger.error('No analysis data for id=' + analysisId);
        return;
    }

    var btn = document.querySelector('.comos-export-btn[data-analysis-id="' + analysisId + '"]');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '\u23F3 Exporting...';
    }

    // Collect the current selections
    var selections = analysis.items.map(function (sel) {
        return {
            tag: sel.tag,
            SystemFullName: sel.selectedSystemFullName,
            Confiança: sel.selectedConf,
            Tipo_ref: sel.selectedType
        };
    });

    // POST selections to gateway for re-export
    var exportUrl = analysis.excelUrl;
    if (!exportUrl) {
        Logger.error('No excelUrl for analysis ' + analysisId);
        if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDCE5 Export with Selections'; }
        return;
    }

    // Use the base gateway URL (extract from excelUrl)
    var gatewayMatch = exportUrl.match(/(https?:\/\/[^/]+)/);
    var gatewayBase = gatewayMatch ? gatewayMatch[1] : 'http://localhost:8100';

    fetch(gatewayBase + '/comos/export-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pages: [{ resultado: selections }],
            filename: 'analysis_with_selections.xlsx',
            diagram_type: 'pid'
        })
    })
    .then(function (resp) {
        if (!resp.ok) throw new Error('Export failed: HTTP ' + resp.status);
        return resp.json();
    })
    .then(function (data) {
        var downloadUrl = gatewayBase + '/comos/download/' + data.file_id;
        var fname = data.filename || 'analysis_with_selections.xlsx';
        // Save to disk via shim (CefSharp has no download handler)
        var shimBase = _detectShimBase();
        return fetch(shimBase + '/api/ai/v1/save-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: downloadUrl, filename: fname })
        });
    })
    .then(function (resp) {
        if (!resp.ok) throw new Error('Save failed: HTTP ' + resp.status);
        return resp.json();
    })
    .then(function (result) {
        if (btn) { btn.disabled = false; btn.textContent = '\u2705 Saved: ' + (result.filename || 'export'); }
        Logger.info('Export with selections saved to disk', result.path);
    })
    .catch(function (err) {
        Logger.error('Export with selections failed', err.message);
        if (btn) { btn.disabled = false; btn.textContent = '\u274C Export failed — Retry'; }
    });
}

/**
 * Watches for assistant messages that contain embedded analysis data (comos-data code blocks).
 * When found, extracts the JSON data and injects an interactive confidence table.
 */
function setupConfidenceTableInjector() {
    injectConfidenceTableStyles();

    // Observe the chat widget for new messages
    const observer = new MutationObserver(function (mutations) {
        // Look for code blocks with class "language-comos-data"
        var codeBlocks = document.querySelectorAll('code.language-comos-data:not([data-processed])');

        codeBlocks.forEach(function (codeEl) {
            codeEl.dataset.processed = 'true';

            try {
                var jsonStr = codeEl.textContent.trim();
                var data = JSON.parse(jsonStr);

                if (!data || !data.items || !Array.isArray(data.items)) {
                    Logger.warn('comos-data block has no items array');
                    return;
                }

                // Hide the code block (pre > code)
                var preEl = codeEl.closest('pre');
                if (preEl) {
                    preEl.style.display = 'none';
                }

                // Build and inject the interactive confidence table
                var analysisId = data.analysisId || ('analysis-' + Date.now());
                var excelUrl = data.excelUrl || '';
                var tableEl = buildConfidenceTable(data.items, analysisId, excelUrl);

                // Insert after the hidden pre block
                if (preEl && preEl.parentNode) {
                    preEl.parentNode.insertBefore(tableEl, preEl.nextSibling);
                }

                Logger.info('Confidence table injected', { analysisId: analysisId, itemCount: data.items.length });
            } catch (err) {
                Logger.error('Failed to parse comos-data block', err.message);
            }
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    Logger.info('Confidence table injector installed');
}

//#endregion CONFIDENCE TABLE INJECTOR

//#region SCRIPT EXECUTION PANEL

/**
 * CSS for the VBS script execution panel.
 * Injected once at init.
 */
function injectScriptPanelStyles() {
    if (document.getElementById('comos-script-styles')) return;
    var style = document.createElement('style');
    style.id = 'comos-script-styles';
    style.textContent = [
        '.comos-script-panel { border:1px solid #4a9eff; border-radius:8px; margin:8px 0; overflow:hidden; background:#f8fafd; font-family:system-ui,-apple-system,sans-serif; }',
        '.comos-script-header { background:linear-gradient(135deg,#1a5276,#2980b9); color:#fff; padding:12px 16px; display:flex; align-items:center; gap:8px; }',
        '.comos-script-header-icon { font-size:20px; }',
        '.comos-script-header-text { flex:1; }',
        '.comos-script-header-text h3 { margin:0; font-size:14px; font-weight:600; }',
        '.comos-script-header-text span { font-size:12px; opacity:0.85; }',
        '.comos-script-actions { display:flex; gap:8px; padding:12px 16px; border-bottom:1px solid #e0e0e0; flex-wrap:wrap; }',
        '.comos-script-btn { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border:none; border-radius:6px; font-size:13px; font-weight:500; cursor:pointer; transition:all 0.2s; }',
        '.comos-script-btn-copy { background:#2980b9; color:#fff; }',
        '.comos-script-btn-copy:hover { background:#1a5276; }',
        '.comos-script-btn-download { background:#27ae60; color:#fff; }',
        '.comos-script-btn-download:hover { background:#1e8449; }',
        '.comos-script-btn-toggle { background:#ecf0f1; color:#2c3e50; border:1px solid #bdc3c7; }',
        '.comos-script-btn-toggle:hover { background:#d5dbdb; }',
        '.comos-script-instructions { padding:10px 16px; background:#eaf2f8; font-size:12px; color:#2c3e50; border-bottom:1px solid #e0e0e0; }',
        '.comos-script-instructions ol { margin:4px 0 0 16px; padding:0; }',
        '.comos-script-instructions li { margin:2px 0; }',
        '.comos-script-code-wrapper { display:none; max-height:300px; overflow:auto; }',
        '.comos-script-code-wrapper.expanded { display:block; }',
        '.comos-script-code { margin:0; padding:12px 16px; background:#1e1e1e; color:#d4d4d4; font-size:12px; font-family:Consolas,"Courier New",monospace; white-space:pre; overflow-x:auto; }',
        '.comos-script-copied { color:#27ae60; font-weight:600; font-size:12px; padding:0 8px; display:none; align-items:center; }',
    ].join('\n');
    document.head.appendChild(style);
}

/**
 * Build the interactive script execution panel.
 * @param {object} data - { scriptId, filename, downloadUrl, path, itemsCount, diagramName, script }
 * @returns {HTMLElement}
 */
function buildScriptPanel(data) {
    var panel = document.createElement('div');
    panel.className = 'comos-script-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'comos-script-header';
    header.innerHTML =
        '<span class="comos-script-header-icon">\uD83D\uDCDD</span>' +
        '<div class="comos-script-header-text">' +
        '<h3>Script VBS \u2014 ' + (data.itemsCount || '?') + ' itens</h3>' +
        '<span>Diagrama: ' + (data.diagramName || 'documento selecionado') + '</span>' +
        '</div>';
    panel.appendChild(header);

    // Action buttons
    var actions = document.createElement('div');
    actions.className = 'comos-script-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'comos-script-btn comos-script-btn-copy';
    copyBtn.innerHTML = '\uD83D\uDCCB Copiar para Clipboard';
    copyBtn.title = 'Copia o script para a área de transferência';

    var copiedLabel = document.createElement('span');
    copiedLabel.className = 'comos-script-copied';
    copiedLabel.textContent = '\u2705 Copiado!';

    var downloadBtn = document.createElement('a');
    downloadBtn.className = 'comos-script-btn comos-script-btn-download';
    downloadBtn.innerHTML = '\uD83D\uDCBE Baixar ' + (data.filename || 'script.vbs');
    downloadBtn.href = data.downloadUrl || '#';
    downloadBtn.setAttribute('target', '_blank');

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'comos-script-btn comos-script-btn-toggle';
    toggleBtn.innerHTML = '\u25BC Ver C\u00F3digo';

    actions.appendChild(copyBtn);
    actions.appendChild(copiedLabel);
    actions.appendChild(downloadBtn);
    actions.appendChild(toggleBtn);
    panel.appendChild(actions);

    // Instructions
    var instructions = document.createElement('div');
    instructions.className = 'comos-script-instructions';
    instructions.innerHTML =
        '<strong>Como executar:</strong>' +
        '<ol>' +
        '<li>Clique em <strong>\uD83D\uDCCB Copiar para Clipboard</strong> acima</li>' +
        '<li>No COMOS, abra o <strong>Object Debugger</strong> (menu <em>Ferramentas &gt; Scripting</em>)</li>' +
        '<li>Cole o script (<strong>Ctrl+V</strong>) e pressione <strong>F5</strong> para executar</li>' +
        '</ol>' +
        'O script usar\u00E1 o documento selecionado no navegador do COMOS.';
    panel.appendChild(instructions);

    // Collapsible code viewer
    var codeWrapper = document.createElement('div');
    codeWrapper.className = 'comos-script-code-wrapper';
    var codeEl = document.createElement('pre');
    codeEl.className = 'comos-script-code';
    codeEl.textContent = data.script || '';
    codeWrapper.appendChild(codeEl);
    panel.appendChild(codeWrapper);

    // Event: copy to clipboard
    copyBtn.addEventListener('click', function () {
        var text = data.script || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                copiedLabel.style.display = 'inline-flex';
                copyBtn.innerHTML = '\u2705 Copiado!';
                setTimeout(function () {
                    copiedLabel.style.display = 'none';
                    copyBtn.innerHTML = '\uD83D\uDCCB Copiar para Clipboard';
                }, 3000);
            }).catch(function () {
                fallbackCopy(text, copyBtn, copiedLabel);
            });
        } else {
            fallbackCopy(text, copyBtn, copiedLabel);
        }
    });

    // Event: download via shim save-to-disk (CefSharp has no download handler)
    downloadBtn.addEventListener('click', async function (e) {
        if (data.downloadUrl) {
            e.preventDefault();
            downloadBtn.innerHTML = '\u23F3 Saving...';
            try {
                var shimBase = _detectShimBase();
                var resp = await fetch(shimBase + '/api/ai/v1/save-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: data.downloadUrl, filename: data.filename })
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                var result = await resp.json();
                if (result.status === 'saved') {
                    downloadBtn.innerHTML = '\u2705 Saved: ' + result.filename;
                    downloadBtn.title = result.path;
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (dlErr) {
                Logger.error('VBS save-to-disk failed', dlErr.message);
                downloadBtn.innerHTML = '\u274C Download failed';
            }
            setTimeout(function () {
                downloadBtn.innerHTML = '\uD83D\uDCBE Baixar ' + (data.filename || 'script.vbs');
            }, 5000);
        }
    });

    // Event: toggle code display
    toggleBtn.addEventListener('click', function () {
        var expanded = codeWrapper.classList.toggle('expanded');
        toggleBtn.innerHTML = expanded ? '\u25B2 Ocultar C\u00F3digo' : '\u25BC Ver C\u00F3digo';
    });

    return panel;
}

/** Fallback copy for environments without Clipboard API */
function fallbackCopy(text, btn, label) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        label.style.display = 'inline-flex';
        btn.innerHTML = '\u2705 Copiado!';
        setTimeout(function () { label.style.display = 'none'; btn.innerHTML = '\uD83D\uDCCB Copiar para Clipboard'; }, 3000);
    } catch (e) {
        Logger.error('Fallback copy failed', e.message);
    }
    document.body.removeChild(ta);
}

/**
 * Watches for assistant messages that contain `comos-script` code blocks.
 * When found, extracts JSON and injects an interactive script execution panel.
 */
function setupScriptBlockHandler() {
    injectScriptPanelStyles();

    var observer = new MutationObserver(function () {
        var codeBlocks = document.querySelectorAll('code.language-comos-script:not([data-script-processed])');

        codeBlocks.forEach(function (codeEl) {
            codeEl.dataset.scriptProcessed = 'true';

            try {
                var jsonStr = codeEl.textContent.trim();
                var data = JSON.parse(jsonStr);

                if (!data || !data.script) {
                    Logger.warn('comos-script block has no script content');
                    return;
                }

                // Hide the raw code block
                var preEl = codeEl.closest('pre');
                if (preEl) {
                    preEl.style.display = 'none';
                }

                // Build and inject the interactive panel
                var panelEl = buildScriptPanel(data);

                if (preEl && preEl.parentNode) {
                    preEl.parentNode.insertBefore(panelEl, preEl.nextSibling);
                }

                Logger.info('Script execution panel injected', { scriptId: data.scriptId, items: data.itemsCount });
            } catch (err) {
                Logger.error('Failed to parse comos-script block', err.message);
            }
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    Logger.info('Script block handler installed');
}

//#endregion SCRIPT EXECUTION PANEL

//#region FILE UPLOAD BUTTON FIX

/**
 * The bundled chat widget renders a "+" button inside .left-actions
 * but does NOT attach an onClick handler.  We inject one that opens
 * a hidden <input type="file" accept=".pdf"> and, on selection,
 * programmatically submits the file through the widget's message pipeline.
 */
function setupFileUploadButton() {
    // Create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf,application/pdf';
    fileInput.style.display = 'none';
    fileInput.id = 'comos-pdf-file-input';
    document.body.appendChild(fileInput);

    // When a file is selected, store it and notify the user
    fileInput.addEventListener('change', async function () {
        if (!fileInput.files || fileInput.files.length === 0) return;

        const file = fileInput.files[0];
        if (!isPdfFile(file)) {
            Logger.warn('Non-PDF file selected', file.name);
            if (appState.widgetInstance && appState.widgetInstance.addMessageToConversation) {
                const cid = appState.conversationState.currentConversationId;
                if (cid) {
                    appState.widgetInstance.addMessageToConversation(cid, 'assistant',
                        '⚠️ Only PDF files are supported. Please select a PDF file.');
                }
            }
            fileInput.value = '';
            return;
        }

        Logger.info('PDF file selected via + button', file.name);

        // Store file for the next message submission
        window._pendingPdfFile = file;

        // Show confirmation in chat
        if (appState.widgetInstance && appState.widgetInstance.addMessageToConversation) {
            const cid = appState.conversationState.currentConversationId;
            if (cid) {
                appState.widgetInstance.addMessageToConversation(cid, 'assistant',
                    `📎 File **${file.name}** attached (${(file.size / 1024).toFixed(0)} KB).\n\n` +
                    `Now type what type of diagram it is:\n` +
                    `**1** — P&ID (Piping and Instrumentation Diagram)\n` +
                    `**2** — Electrical Diagram\n` +
                    `**3** — Tags Only (Extract tags from diagrams → ISA/IEC descriptions → Hierarchy creation)\n` +
                    `**4** — Document (Extract equipment/tags from RFQs, specs, equipment lists, datasheets)\n\n` +
                    `_Reply by typing **1**, **2**, **3**, or **4**, or write the type (e.g. "P&ID", "Electrical", "Tags only", or "Document")._`);
            }
        }

        // Reset file input so the same file can be re-selected
        fileInput.value = '';
    });

    // Use MutationObserver to find and wire up the + button
    // (the widget renders asynchronously)
    const observer = new MutationObserver(function (mutations) {
        const leftActions = document.querySelector('.left-actions');
        if (!leftActions) return;

        const btn = leftActions.querySelector('button, ix-icon-button, [class*="icon-button"]');
        if (btn && !btn.dataset.fileUploadWired) {
            btn.dataset.fileUploadWired = 'true';
            btn.title = 'Attach PDF file';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
            Logger.info('File upload button wired successfully');
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also try immediately in case widget is already rendered
    setTimeout(function () {
        const leftActions = document.querySelector('.left-actions');
        if (!leftActions) return;
        const btn = leftActions.querySelector('button, ix-icon-button, [class*="icon-button"]');
        if (btn && !btn.dataset.fileUploadWired) {
            btn.dataset.fileUploadWired = 'true';
            btn.title = 'Attach PDF file';
            btn.style.cursor = 'pointer';
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
            Logger.info('File upload button wired (immediate)');
        }
    }, 2000);
}

//#endregion FILE UPLOAD BUTTON FIX




