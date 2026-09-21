import { AuthorizationDenied, authorizeOperation, type Operation, type OperationBus } from "@yteruel31/pi-operation-hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Per-call identity, never mutable runtime-wide state (Pi can execute tools concurrently). */
export interface McpOperationContext {
	context?: ExtensionContext;
	rootToolCallId?: string;
}

/** Policy and UI belong to event-bus providers, not the MCP producer. */
export async function withMcpAuthorization<T>(
	bus: OperationBus | undefined,
	operation: Omit<Operation, "package">,
	context: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
	execute: () => Promise<T>,
	isError: (value: T) => boolean = () => false,
): Promise<T> {
	const authorization = await authorizeOperation(bus, { ...operation, package: "mcp" }, context, signal);
	let failed = true;
	try {
		// A provider may finish assessing in the same tick as cancellation.
		if (signal?.aborted) throw new Error("MCP operation cancelled");
		const value = await execute();
		const executionFailed = isError(value);
		if (!bus) { failed = executionFailed; return value; }
		const inspected = await authorization.inspectDelivery(value, signal);
		failed = executionFailed;
		return inspected;
	} catch (error) {
		if (error instanceof AuthorizationDenied || !bus) throw error;
		throw new Error("MCP operation failed.");
	} finally {
		authorization.result(failed);
	}
}
