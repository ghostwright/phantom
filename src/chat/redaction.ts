const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AUTH_QUERY_PATTERN =
	/([?&](?:code|access_token|refresh_token|id_token|client_secret|token|secret|api_key|key|magic|password)=)[^&\s"'<>]+/gi;
const HEADER_SECRET_PATTERN =
	/(\b(?:x[-_])?[a-z0-9_-]*(?:api[-_]?key|access[-_]?key|private[-_]?key|csrf[-_]?token|xsrf[-_]?token|csrf|xsrf|token|secret|password|auth|credential|session)[a-z0-9_-]*\s*:\s*)([^\s,;]+)/gi;
const ASSIGNMENT_SECRET_PATTERN =
	/([a-z0-9_]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|auth|credential|session|oauth|csrf|xsrf)[a-z0-9_]*\s*=\s*)([^\s&]+)/gi;
const UPPER_ASSIGNMENT_SECRET_PATTERN =
	/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|SESSION|CODE|CSRF|XSRF)[A-Z0-9_]*\s*=\s*)([^\s&]+)/g;
const OPENAI_SECRET_PATTERN = /\b(sk-[a-z0-9_-]{12,})\b/gi;
const SINGLE_LINE_BLOB_PATTERN = /\b([a-z0-9+/]{80,}={0,2})\b/gi;
const LINE_WRAPPED_BLOB_PATTERN = /(?:\b[A-Za-z0-9+/]{40,}={0,2}\b[\r\n\t ]*){3,}/g;

export function redactSensitiveText(value: string): string {
	let output = value;
	output = output.replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");
	output = output.replace(AWS_ACCESS_KEY_PATTERN, "[REDACTED_AWS_KEY]");
	output = output.replace(AUTH_QUERY_PATTERN, "$1[REDACTED]");
	output = output.replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
	output = output.replace(/basic\s+[a-z0-9._~+/=-]+/gi, "Basic [REDACTED]");
	output = output.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
	output = output.replace(/(\bcookie\s*[:=]\s*)([^\n]+)/gi, "$1[REDACTED]");
	output = output.replace(HEADER_SECRET_PATTERN, "$1[REDACTED]");
	output = output.replace(ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]");
	output = output.replace(UPPER_ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]");
	output = output.replace(OPENAI_SECRET_PATTERN, "[REDACTED_SECRET]");
	output = output.replace(LINE_WRAPPED_BLOB_PATTERN, "[REDACTED_BLOB]");
	output = output.replace(SINGLE_LINE_BLOB_PATTERN, "[REDACTED_BLOB]");
	return output;
}
