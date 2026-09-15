// Minimal compiled dsh-client-resources 0.1.5-rc.1 protocolOf fixture.
// The test extracts this function exactly as it extracts the snapshot artifact.
function protocolOf(address) {
			let parsed;
			try {
				parsed = new URL(address);
			} catch {
				return;
			}
			if (parsed.protocol !== `dsh-resource:`) return void 0;
			return parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();
		}
