# BPP V5 Data Pipeline

This Worker receives completed game-run Bundles and makes them discoverable by trusted analyzers, Ghost Battle clients, and BazaarDB.

## Language

**Bundle**: The smallest immutable upload, storage, and delivery unit. It contains exactly one Run and, when available, one optional Screenshot.

**Run**: Immutable facts, battles, card state, and replay data for one completed game run. It excludes the Screenshot.

**Screenshot**: The optional end-of-run image stored inside the Bundle. Its absence never invalidates the Bundle.

**BazaarDB Delivery**: A claimable obligation to deliver one Screenshot-bearing Bundle to BazaarDB. Settling a delivery does not delete the Bundle.

**Ghost Battle**: A directional query projection derived from a Bundle manifest. It is not authoritative Battle data.

Avoid the V4 and abandoned names: Boundle, Pack, Run artifact, Run Bundle, Snapshot, and Screenshot upload.
