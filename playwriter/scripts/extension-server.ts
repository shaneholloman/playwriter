import { startRelayServer } from '../src/extension/extensionContextFactory'

async function main() {
    const controller = new AbortController()
    const { cdpRelayServer } = await startRelayServer(
        controller.signal,
    )
}

main()
