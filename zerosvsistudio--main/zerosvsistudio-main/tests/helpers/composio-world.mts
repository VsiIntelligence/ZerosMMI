/**
 * A realistic stand-in for Composio: real-style action slugs (not the made-up names the older tests used), real-style schemas,
 * strict argument validation like the real service, big catalogues (so retrieval is a needle-in-a-haystack problem), connection
 * lifecycles (INITIATED -> ACTIVE, EXPIRED -> refreshed), and a proxy. Used to prove apps work the same way for every app.
 */
export type Row = { slug: string; description: string; input_parameters: Record<string, unknown> };

/** "owner*:string,labels:array<string>,per_page:integer" -> Composio v3's direct map of parameter definitions. */
function directMap(spec: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z_0-9]+)(\*)?:?([a-z]+)?(?:<([a-z]+)>)?$/i.exec(part);
    if (!m) throw new Error(`bad spec ${part}`);
    const [, name, req, type = "string", item] = m;
    out[name!] = { type, description: `${name!.replace(/_/g, " ")}`, required: !!req, ...(item ? { items: { type: item } } : {}) };
  }
  return out;
}
/** The same thing in JSON Schema shape (some Composio responses use it). */
function jsonSchema(spec: string): Record<string, unknown> {
  const map = directMap(spec);
  return { type: "object", properties: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { ...(v as object), required: undefined }])), required: Object.entries(map).filter(([, v]) => (v as { required: boolean }).required).map(([k]) => k) };
}
function rowsFrom(table: string, shape: "direct" | "schema"): Row[] {
  return table.trim().split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [slug, description, params = ""] = line.split("|").map((x) => x.trim());
    return { slug: slug!, description: description!, input_parameters: shape === "direct" ? directMap(params) : jsonSchema(params) };
  });
}

const GITHUB_REAL = `
GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER|Lists repositories that the authenticated user has explicit permission to access|visibility,sort,per_page:integer,page:integer
GITHUB_LIST_ORGANIZATION_REPOSITORIES|Lists repositories for the specified organization|org*,type,per_page:integer
GITHUB_LIST_REPOSITORIES_ACCESSIBLE_TO_THE_APP|List repositories accessible to the app installation using an installation access token|
GITHUB_GET_A_REPOSITORY|Gets the full details of a repository|owner*,repo*
GITHUB_GET_THE_AUTHENTICATED_USER|Gets the profile of the authenticated user|
GITHUB_LIST_REPOSITORY_ISSUES|Lists the issues of a repository|owner*,repo*,state,labels,per_page:integer
GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER|List issues assigned to the authenticated user across all visible repositories|filter,state,per_page:integer
GITHUB_GET_AN_ISSUE|Gets one issue|owner*,repo*,issue_number*:integer
GITHUB_LIST_PULL_REQUESTS|Lists pull requests of a repository|owner*,repo*,state,head,base
GITHUB_GET_A_PULL_REQUEST|Gets one pull request|owner*,repo*,pull_number*:integer
GITHUB_LIST_BRANCHES|Lists branches of a repository|owner*,repo*
GITHUB_GET_A_BRANCH|Gets one branch|owner*,repo*,branch*
GITHUB_GET_REPOSITORY_CONTENT|Gets the contents of a file or directory in a repository such as the README or source files|owner*,repo*,path*,ref
GITHUB_LIST_COMMITS|Lists commits of a repository|owner*,repo*,sha,path,per_page:integer
GITHUB_GET_A_COMMIT|Gets a single commit|owner*,repo*,ref*
GITHUB_GET_A_REFERENCE|Gets a git reference such as a branch or tag|owner*,repo*,ref*
GITHUB_SEARCH_REPOSITORIES|Search repositories on GitHub|q*,sort,per_page:integer
GITHUB_SEARCH_CODE|Search code across repositories|q*
GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS|Search issues and pull requests|q*
GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER|Lists notifications for the authenticated user|all:boolean
GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY|Lists GitHub Actions workflow runs|owner*,repo*
GITHUB_LIST_ARTIFACTS_FOR_A_REPOSITORY|Lists GitHub Actions artifacts for a repository|owner*,repo*
GITHUB_LIST_RELEASES|Lists releases|owner*,repo*
GITHUB_LIST_REPOSITORY_COLLABORATORS|Lists collaborators of a repository|owner*,repo*
GITHUB_LIST_CODE_SCANNING_ALERTS_FOR_A_REPOSITORY|Lists code scanning alerts|owner*,repo*,state
GITHUB_LIST_ISSUE_COMMENTS|Lists comments on an issue|owner*,repo*,issue_number*:integer
GITHUB_CREATE_AN_ISSUE|Creates an issue in a repository|owner*,repo*,title*,body,labels:array<string>,assignees:array<string>
GITHUB_UPDATE_AN_ISSUE|Updates an issue (title, body, state)|owner*,repo*,issue_number*:integer,title,body,state
GITHUB_CREATE_AN_ISSUE_COMMENT|Adds a comment to an issue|owner*,repo*,issue_number*:integer,body*
GITHUB_CREATE_A_PULL_REQUEST|Opens a pull request|owner*,repo*,title*,head*,base*,body,draft:boolean
GITHUB_MERGE_A_PULL_REQUEST|Merges a pull request|owner*,repo*,pull_number*:integer,merge_method
GITHUB_CREATE_A_REFERENCE|Creates a git reference, which creates a branch or tag|owner*,repo*,ref*,sha*
GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS|Creates or updates a file in a repository (a commit)|owner*,repo*,path*,message*,content*,branch,sha
GITHUB_DELETE_A_FILE|Deletes a file from a repository|owner*,repo*,path*,message*,sha*
GITHUB_DELETE_A_REPOSITORY|Permanently deletes a repository|owner*,repo*
GITHUB_DELETE_A_REFERENCE|Deletes a git reference (a branch or tag)|owner*,repo*,ref*
GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER|Stars a repository|owner*,repo*
GITHUB_CREATE_A_FORK|Forks a repository|owner*,repo*
GITHUB_CREATE_A_RELEASE|Creates a release|owner*,repo*,tag_name*,name,body
GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER|Creates a new repository for the authenticated user|name*,description,private:boolean
GITHUB_ADD_LABELS_TO_AN_ISSUE|Adds labels to an issue|owner*,repo*,issue_number*:integer,labels*:array<string>
GITHUB_CREATE_A_COMMIT|Creates a git commit object|owner*,repo*,message*,tree*,parents*:array<string>
`;

const NOUNS = ["AUTOLINKS", "DEPLOY_KEYS", "DEPLOYMENTS", "ENVIRONMENTS", "WEBHOOKS", "SECRETS", "VARIABLES", "RUNNERS", "CODESPACES", "PACKAGES", "CACHES", "JOBS", "TOPICS", "STARGAZERS", "SUBSCRIBERS", "TEAMS", "MEMBERS", "INVITATIONS", "MILESTONES", "PROJECTS", "PAGES", "TAGS", "LANGUAGES", "CONTRIBUTORS", "SPONSORS", "GISTS", "FOLLOWERS", "SSH_KEYS", "GPG_KEYS", "BLOCKED_USERS", "RULESETS", "SECURITY_ADVISORIES", "DEPENDABOT_ALERTS", "SECRET_SCANNING_ALERTS", "CHECK_RUNS", "CHECK_SUITES", "COMMIT_STATUSES", "REACTIONS", "REVIEW_COMMENTS", "LICENSES", "APP_INSTALLATIONS", "OIDC_CUSTOMIZATIONS", "COPILOT_SEATS", "AUDIT_LOG_EVENTS", "ISSUE_EVENTS", "ISSUE_TIMELINES", "ASSIGNEES", "PROTECTED_BRANCHES", "LFS_SETTINGS", "TRAFFIC_VIEWS", "CLONE_TRAFFIC", "REFERRERS", "DISCUSSIONS", "PACKAGE_VERSIONS", "SELF_HOSTED_RUNNERS", "WORKFLOW_USAGE", "REPOSITORY_RULES", "CUSTOM_PROPERTIES", "DEPLOYMENT_BRANCH_POLICIES", "PAGES_BUILDS"];
function filler(): Row[] {
  const out: Row[] = [];
  for (const n of NOUNS) {
    const noun = n.toLowerCase().replace(/_/g, " ");
    out.push(
      { slug: `GITHUB_LIST_${n}_FOR_A_REPOSITORY`, description: `Lists the ${noun} of a repository`, input_parameters: directMap("owner*,repo*,per_page:integer") },
      { slug: `GITHUB_GET_A_${n.replace(/S$/, "")}`, description: `Gets one ${noun.replace(/s$/, "")}`, input_parameters: directMap("owner*,repo*,id*:integer") },
      { slug: `GITHUB_CREATE_A_${n.replace(/S$/, "")}`, description: `Creates a ${noun.replace(/s$/, "")} in a repository`, input_parameters: directMap("owner*,repo*,name*") },
      { slug: `GITHUB_UPDATE_A_${n.replace(/S$/, "")}`, description: `Updates a ${noun.replace(/s$/, "")}`, input_parameters: directMap("owner*,repo*,id*:integer,name") },
      { slug: `GITHUB_DELETE_A_${n.replace(/S$/, "")}`, description: `Deletes a ${noun.replace(/s$/, "")}`, input_parameters: directMap("owner*,repo*,id*:integer") },
      { slug: `GITHUB_LIST_${n}_FOR_AN_ORGANIZATION`, description: `Lists the ${noun} of an organization`, input_parameters: directMap("org*,per_page:integer") },
      { slug: `GITHUB_LIST_${n}_FOR_THE_AUTHENTICATED_USER`, description: `Lists the ${noun} of the authenticated user`, input_parameters: directMap("per_page:integer") },
    );
  }
  return out;
}

const GMAIL = `
GMAIL_SEND_EMAIL|Sends an email message|recipient_email*,subject,body*,cc:array<string>,is_html:boolean
GMAIL_FETCH_EMAILS|Fetches emails from the mailbox, supports a Gmail search query|query,max_results:integer,label_ids:array<string>
GMAIL_CREATE_EMAIL_DRAFT|Creates an email draft|recipient_email*,subject,body*
GMAIL_REPLY_TO_THREAD|Replies to an email thread|thread_id*,message_body*,recipient_email*
GMAIL_DELETE_MESSAGE|Permanently deletes a message|message_id*
GMAIL_ADD_LABEL_TO_EMAIL|Adds or removes labels on an email|message_id*,add_label_ids:array<string>
GMAIL_LIST_LABELS|Lists the labels of the mailbox|
GMAIL_GET_PROFILE|Gets the Gmail profile (address, message counts)|
GMAIL_FETCH_MESSAGE_BY_THREAD_ID|Fetches all messages of a thread|thread_id*
GMAIL_MOVE_TO_TRASH|Moves a message to the trash|message_id*
GMAIL_FORWARD_MESSAGE|Forwards a message to another recipient|message_id*,recipient_email*
GMAIL_LIST_DRAFTS|Lists drafts|max_results:integer
GMAIL_SEND_DRAFT|Sends an existing draft|draft_id*
GMAIL_SEARCH_PEOPLE|Searches contacts and people|query*
`;
const SLACK = `
SLACK_SEND_MESSAGE|Posts a message to a channel or user|channel*,text*,thread_ts
SLACK_LIST_ALL_CHANNELS|Lists all channels in the workspace|limit:integer,types
SLACK_FIND_USERS|Finds users by name or email|search_query*
SLACK_SEARCH_MESSAGES|Searches messages in the workspace|query*,count:integer
SLACK_CREATE_CHANNEL|Creates a channel|name*,is_private:boolean
SLACK_ADD_REACTION_TO_AN_ITEM|Adds an emoji reaction to a message|channel*,timestamp*,name*
SLACK_FETCH_CONVERSATION_HISTORY|Fetches messages of a conversation|channel*,limit:integer
SLACK_DELETE_A_MESSAGE|Deletes a message|channel*,ts*
SLACK_UPDATE_A_MESSAGE|Edits a message|channel*,ts*,text*
SLACK_INVITE_USERS_TO_A_CHANNEL|Invites users to a channel|channel*,users*
SLACK_SET_STATUS|Sets the status of the user|status_text*,status_emoji
SLACK_LIST_ALL_USERS|Lists all users|limit:integer
SLACK_ARCHIVE_A_CHANNEL|Archives a channel|channel*
`;
const NOTION = `
NOTION_SEARCH_NOTION_PAGE|Searches pages and databases by title|query,page_size:integer
NOTION_CREATE_NOTION_PAGE|Creates a page under a parent page or database|parent_id*,title*
NOTION_FETCH_DATA|Fetches pages and databases the integration can see|get_all:boolean,get_pages:boolean,get_databases:boolean
NOTION_QUERY_DATABASE|Queries a database with filters and sorts|database_id*,page_size:integer
NOTION_ADD_PAGE_CONTENT|Appends content blocks to a page|parent_block_id*,content_block*
NOTION_UPDATE_PAGE|Updates page properties or archives it|page_id*,archived:boolean
NOTION_INSERT_ROW_DATABASE|Inserts a row in a database|database_id*,properties*
NOTION_FETCH_BLOCK_CONTENTS|Fetches the blocks of a page|block_id*
NOTION_ARCHIVE_NOTION_PAGE|Archives (deletes) a page|page_id*
NOTION_CREATE_DATABASE|Creates a database|parent_id*,title*,properties*
NOTION_LIST_USERS|Lists the users of the workspace|page_size:integer
`;
const CALENDAR = `
GOOGLECALENDAR_CREATE_EVENT|Creates a calendar event|summary*,start_datetime*,event_duration_hour:integer,attendees:array<string>,location
GOOGLECALENDAR_FIND_EVENT|Finds events by text or time range|query,timeMin,timeMax
GOOGLECALENDAR_LIST_CALENDARS|Lists the calendars of the user|
GOOGLECALENDAR_DELETE_EVENT|Deletes an event|event_id*,calendar_id
GOOGLECALENDAR_UPDATE_EVENT|Updates an event|event_id*,summary,start_datetime
GOOGLECALENDAR_QUICK_ADD|Creates an event from a natural-language text|text*
GOOGLECALENDAR_FIND_FREE_SLOTS|Finds free time slots|time_min*,time_max*
GOOGLECALENDAR_GET_CURRENT_DATE_TIME|Gets the current date and time in a timezone|timezone
GOOGLECALENDAR_EVENTS_LIST|Lists events of a calendar|calendar_id,max_results:integer
`;
const DRIVE = `
GOOGLEDRIVE_FIND_FILE|Finds files by name or query|q,page_size:integer
GOOGLEDRIVE_CREATE_FOLDER|Creates a folder|name*,parent_id
GOOGLEDRIVE_UPLOAD_FILE|Uploads a file|file_to_upload*,folder_to_upload_to
GOOGLEDRIVE_DOWNLOAD_FILE|Downloads a file|file_id*
GOOGLEDRIVE_DELETE_FILE|Deletes a file|file_id*
GOOGLEDRIVE_CREATE_FILE_FROM_TEXT|Creates a file from text|file_name*,text_content*
GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE|Shares a file with a person or the public|file_id*,role*,type*,email_address
GOOGLEDRIVE_LIST_FILES|Lists files in the drive|page_size:integer
GOOGLEDRIVE_MOVE_FILE|Moves a file to another folder|file_id*,add_parents*
GOOGLEDRIVE_GET_ABOUT|Gets information about the user and drive|
`;
const SHEETS = `
GOOGLESHEETS_BATCH_GET|Reads ranges from a spreadsheet|spreadsheet_id*,ranges:array<string>
GOOGLESHEETS_BATCH_UPDATE|Writes values to a range in a spreadsheet|spreadsheet_id*,sheet_name*,values*:array<array>
GOOGLESHEETS_CREATE_GOOGLE_SHEET1|Creates a new spreadsheet|title*
GOOGLESHEETS_ADD_SHEET|Adds a worksheet to a spreadsheet|spreadsheetId*,properties
GOOGLESHEETS_APPEND_DIMENSION|Appends rows or columns|spreadsheet_id*,sheet_id*:integer,length*:integer
GOOGLESHEETS_GET_SPREADSHEET_INFO|Gets spreadsheet metadata and sheets|spreadsheet_id*
GOOGLESHEETS_CLEAR_VALUES|Clears values in a range|spreadsheet_id*,range*
GOOGLESHEETS_SEARCH_SPREADSHEETS|Searches spreadsheets|query
`;
const LINEAR = `
LINEAR_CREATE_LINEAR_ISSUE|Creates an issue|team_id*,title*,description,priority:integer
LINEAR_LIST_LINEAR_ISSUES|Lists issues|project_id,first:integer
LINEAR_LIST_LINEAR_TEAMS|Lists teams|
LINEAR_UPDATE_ISSUE|Updates an issue|issue_id*,title,state_id
LINEAR_GET_LINEAR_ISSUE|Gets an issue|issue_id*
LINEAR_CREATE_LINEAR_COMMENT|Comments on an issue|issue_id*,body*
LINEAR_LIST_LINEAR_PROJECTS|Lists projects|
LINEAR_DELETE_LINEAR_ISSUE|Deletes an issue|issue_id*
LINEAR_GET_CURRENT_USER|Gets the current user|
`;
const JIRA = `
JIRA_CREATE_ISSUE|Creates a Jira issue|project_key*,summary*,issue_type*,description
JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET|Searches issues using JQL|jql*,max_results:integer
JIRA_GET_ISSUE|Gets an issue|issue_id_or_key*
JIRA_TRANSITION_ISSUE|Moves an issue to another status|issue_id_or_key*,transition_id*
JIRA_ADD_COMMENT|Adds a comment to an issue|issue_id_or_key*,comment*
JIRA_ASSIGN_ISSUE|Assigns an issue to a user|issue_id_or_key*,account_id*
JIRA_LIST_PROJECTS|Lists projects|
JIRA_DELETE_ISSUE|Deletes an issue|issue_id_or_key*
JIRA_GET_CURRENT_USER|Gets the current user|
`;
const STRIPE = `
STRIPE_LIST_CUSTOMERS|Lists customers|limit:integer,email
STRIPE_CREATE_CUSTOMER|Creates a customer|email*,name
STRIPE_CREATE_INVOICE|Creates an invoice|customer*
STRIPE_LIST_INVOICES|Lists invoices|customer,limit:integer
STRIPE_CREATE_REFUND|Refunds a payment|payment_intent*,amount:integer
STRIPE_LIST_PAYMENT_INTENTS|Lists payments|limit:integer
STRIPE_RETRIEVE_BALANCE|Gets the account balance|
STRIPE_CANCEL_SUBSCRIPTION|Cancels a subscription|subscription_id*
STRIPE_LIST_SUBSCRIPTIONS|Lists subscriptions|customer
`;
const HUBSPOT = `
HUBSPOT_LIST_CONTACTS|Lists contacts|limit:integer
HUBSPOT_CREATE_CONTACT|Creates a contact|email*,firstname,lastname
HUBSPOT_SEARCH_CONTACTS|Searches contacts by property|query*
HUBSPOT_CREATE_DEAL|Creates a deal|dealname*,amount,pipeline
HUBSPOT_LIST_DEALS|Lists deals|limit:integer
HUBSPOT_UPDATE_CONTACT|Updates a contact|contact_id*,properties*
HUBSPOT_CREATE_NOTE|Creates a note on a record|body*,associated_id*
HUBSPOT_DELETE_CONTACT|Deletes a contact|contact_id*
`;
const TRELLO = `
TRELLO_ADD_CARDS|Creates a card on a list|idList*,name*,desc
TRELLO_GET_BOARDS_BY_ID_MEMBERS|Lists the boards of a member|id*
TRELLO_GET_LISTS_BY_ID_BOARD|Lists the lists on a board|id*
TRELLO_UPDATE_CARDS_BY_ID_CARD|Updates a card|id*,name,desc,closed:boolean
TRELLO_DELETE_CARDS_BY_ID_CARD|Deletes a card|id*
TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD|Comments on a card|id*,text*
TRELLO_GET_CARDS_BY_ID_CARD|Gets a card|id*
`;
const ASANA = `
ASANA_CREATE_A_TASK|Creates a task|name*,projects,notes,due_on
ASANA_GET_TASKS_FROM_A_PROJECT|Lists tasks of a project|project_gid*
ASANA_UPDATE_A_TASK|Updates a task|task_gid*,name,completed:boolean
ASANA_GET_MULTIPLE_PROJECTS|Lists projects|workspace
ASANA_ADD_A_COMMENT_TO_A_TASK|Comments on a task|task_gid*,text*
ASANA_DELETE_A_TASK|Deletes a task|task_gid*
ASANA_GET_CURRENT_USER|Gets the current user|
`;
const AIRTABLE = `
AIRTABLE_LIST_RECORDS|Lists records in a table|base_id*,table_id_or_name*,max_records:integer
AIRTABLE_CREATE_RECORD|Creates a record|base_id*,table_id_or_name*,fields*
AIRTABLE_UPDATE_RECORD|Updates a record|base_id*,table_id_or_name*,record_id*,fields*
AIRTABLE_DELETE_RECORD|Deletes a record|base_id*,table_id_or_name*,record_id*
AIRTABLE_LIST_BASES|Lists the bases|
AIRTABLE_GET_BASE_SCHEMA|Gets the tables and fields of a base|base_id*
`;
const DISCORD = `
DISCORD_SEND_MESSAGE|Sends a message to a channel|channel_id*,content*
DISCORD_LIST_GUILD_CHANNELS|Lists channels of a server|guild_id*
DISCORD_LIST_MY_GUILDS|Lists the servers of the user|
DISCORD_DELETE_MESSAGE|Deletes a message|channel_id*,message_id*
DISCORD_GET_CURRENT_USER|Gets the current user|
`;
const DROPBOX = `
DROPBOX_LIST_FILES_IN_FOLDER|Lists files in a folder|path
DROPBOX_CREATE_FOLDER|Creates a folder|path*
DROPBOX_DELETE_FILE_OR_FOLDER|Deletes a file or folder|path*
DROPBOX_GET_ABOUT_ME|Gets the account details|
DROPBOX_READ_FILE|Reads a file|path*
DROPBOX_MOVE_FILE_OR_FOLDER|Moves a file or folder|from_path*,to_path*
`;
const SHOPIFY = `
SHOPIFY_GET_ORDERS_WITH_FILTERS|Lists orders with filters|status,limit:integer
SHOPIFY_CREATE_PRODUCT|Creates a product|title*,body_html
SHOPIFY_LIST_PRODUCTS|Lists products|limit:integer
SHOPIFY_UPDATE_PRODUCT|Updates a product|product_id*,title
SHOPIFY_CANCEL_ORDER|Cancels an order|order_id*
SHOPIFY_GET_SHOP_DETAILS|Gets the shop details|
`;
const ZOOM = `
ZOOM_CREATE_A_MEETING|Creates a meeting|user_id*,topic*,start_time,duration:integer
ZOOM_LIST_MEETINGS|Lists meetings|user_id*
ZOOM_DELETE_A_MEETING|Deletes a meeting|meeting_id*:integer
ZOOM_GET_A_USER|Gets a user|user_id*
`;
const CALENDLY = `
CALENDLY_LIST_EVENTS|Lists scheduled events|user
CALENDLY_GET_CURRENT_USER|Gets the current user|
CALENDLY_CANCEL_EVENT|Cancels a scheduled event|uuid*
CALENDLY_LIST_EVENT_TYPES|Lists event types|user
`;
const TODOIST = `
TODOIST_CREATE_TASK|Creates a task|content*,due_string,project_id
TODOIST_GET_ALL_TASKS|Lists active tasks|project_id
TODOIST_CLOSE_TASK|Completes a task|task_id*
TODOIST_DELETE_TASK|Deletes a task|task_id*
TODOIST_GET_ALL_PROJECTS|Lists projects|
TODOIST_UPDATE_TASK|Updates a task|task_id*,content
`;
const SALESFORCE = `
SALESFORCE_CREATE_LEAD|Creates a lead|LastName*,Company*
SALESFORCE_QUERY_SOQL|Runs a SOQL query|query*
SALESFORCE_UPDATE_RECORD|Updates a record|sobject*,record_id*,fields*
SALESFORCE_LIST_OBJECTS|Lists objects|
SALESFORCE_DELETE_RECORD|Deletes a record|sobject*,record_id*
`;

export type Spec = { slug: string; name: string; rows: Row[] };
export function buildCatalog(): Spec[] {
  return [
    { slug: "github", name: "GitHub", rows: [...rowsFrom(GITHUB_REAL, "direct"), ...filler()] },
    { slug: "gmail", name: "Gmail", rows: rowsFrom(GMAIL, "schema") },
    { slug: "slack", name: "Slack", rows: rowsFrom(SLACK, "direct") },
    { slug: "notion", name: "Notion", rows: rowsFrom(NOTION, "schema") },
    { slug: "googlecalendar", name: "Google Calendar", rows: rowsFrom(CALENDAR, "direct") },
    { slug: "googledrive", name: "Google Drive", rows: rowsFrom(DRIVE, "schema") },
    { slug: "googlesheets", name: "Google Sheets", rows: rowsFrom(SHEETS, "direct") },
    { slug: "linear", name: "Linear", rows: rowsFrom(LINEAR, "direct") },
    { slug: "jira", name: "Jira", rows: rowsFrom(JIRA, "schema") },
    { slug: "stripe", name: "Stripe", rows: rowsFrom(STRIPE, "direct") },
    { slug: "hubspot", name: "HubSpot", rows: rowsFrom(HUBSPOT, "schema") },
    { slug: "trello", name: "Trello", rows: rowsFrom(TRELLO, "direct") },
    { slug: "asana", name: "Asana", rows: rowsFrom(ASANA, "direct") },
    { slug: "airtable", name: "Airtable", rows: rowsFrom(AIRTABLE, "schema") },
    { slug: "discord", name: "Discord", rows: rowsFrom(DISCORD, "direct") },
    { slug: "dropbox", name: "Dropbox", rows: rowsFrom(DROPBOX, "direct") },
    { slug: "shopify", name: "Shopify", rows: rowsFrom(SHOPIFY, "direct") },
    { slug: "zoom", name: "Zoom", rows: rowsFrom(ZOOM, "direct") },
    { slug: "calendly", name: "Calendly", rows: rowsFrom(CALENDLY, "direct") },
    { slug: "todoist", name: "Todoist", rows: rowsFrom(TODOIST, "direct") },
    { slug: "salesforce", name: "Salesforce", rows: rowsFrom(SALESFORCE, "direct") },
  ];
}

/** Strict validation, like the real service: wrong types and unknown fields are refused. */
export function validateArguments(row: Row, args: Record<string, unknown>): string | null {
  const defs = ((): Record<string, { type: string; required?: boolean }> => {
    const p = row.input_parameters as { type?: unknown; properties?: Record<string, { type: string }>; required?: string[] } & Record<string, { type: string; required?: boolean }>;
    if (typeof p.type === "string" && p.properties) return Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, { type: v.type, required: (p.required ?? []).includes(k) }]));
    return p as Record<string, { type: string; required?: boolean }>;
  })();
  for (const [k, v] of Object.entries(args)) {
    const d = defs[k];
    if (!d) return `Extra inputs are not permitted: ${k}`;
    const ok = d.type === "integer" ? Number.isInteger(v) : d.type === "boolean" ? typeof v === "boolean" : d.type === "array" ? Array.isArray(v) : d.type === "string" ? typeof v === "string" : true;
    if (!ok) return `Invalid type for ${k}: expected ${d.type}, got ${Array.isArray(v) ? "array" : typeof v}`;
  }
  for (const [k, d] of Object.entries(defs)) if (d.required && (args[k] === undefined || args[k] === "")) return `Missing required input: ${k}`;
  return null;
}
