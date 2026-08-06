export const API_INTERNAL_URL =
	process.env.API_INTERNAL_URL ??
	process.env.API_URL ??
	"http://localhost:3001";

export function isMarketing(): boolean {
	return process.env.IS_MARKETING === "true";
}
