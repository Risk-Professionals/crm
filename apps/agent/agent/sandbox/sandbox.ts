import { defineSandbox, type SandboxDefinition } from "eve/sandbox";
import {
	type VercelSandboxBootstrapUseOptions,
	type VercelSandboxSessionUseOptions,
	vercel,
} from "eve/sandbox/vercel";

const sandbox: SandboxDefinition<
	VercelSandboxBootstrapUseOptions,
	VercelSandboxSessionUseOptions
> = defineSandbox({
	backend: vercel({ networkPolicy: "deny-all" }),
});

export default sandbox;
