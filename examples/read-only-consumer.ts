import type {
  FlightRecorderReader,
  FlightRecorderSnapshot,
} from 'dsh-request-flight-recorder'

export function attachFlightView(
  reader: FlightRecorderReader,
  render: (snapshot: FlightRecorderSnapshot) => void,
): () => void {
  const info = reader.info()
  if (info.protocolVersion !== 1 || info.recordSchemaVersion !== 1) {
    throw new Error('unsupported flight recorder contract')
  }

  render(reader.snapshot())
  return reader.subscribe(({ revision }) => {
    const snapshot = reader.snapshot({ limit: 20 })
    if (snapshot.revision >= revision) render(snapshot)
  })
}
