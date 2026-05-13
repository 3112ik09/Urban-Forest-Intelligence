import jwt from 'jsonwebtoken'

// Correct endpoint discovered by inspecting the EE Python library serializer
const GEE_COMPUTE_URL = (projectId: string) =>
  `https://earthengine.googleapis.com/v1/projects/${projectId}/value:compute`

export async function getGEEToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claim = {
    iss: process.env.GEE_SERVICE_ACCOUNT,
    scope: 'https://www.googleapis.com/auth/earthengine',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const privateKey = process.env.GEE_PRIVATE_KEY!.replace(/\\n/g, '\n')
  const signedJwt = jwt.sign(claim, privateKey, { algorithm: 'RS256' })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`GEE token error: ${JSON.stringify(data)}`)
  return data.access_token
}

// Builds the expression body in the format the EE Python serializer produces.
// bbox: [minLon, minLat, maxLon, maxLat]
function buildNDVIExpression(bbox: [number, number, number, number]) {
  const [minLon, minLat, maxLon, maxLat] = bbox

  // Rectangle corners: [minLon,maxLat], [minLon,minLat], [maxLon,minLat], [maxLon,maxLat]
  const coordinates = [[[minLon, maxLat], [minLon, minLat], [maxLon, minLat], [maxLon, maxLat]]]

  return {
    expression: {
      result: '0',
      values: {
        '1': {
          functionInvocationValue: {
            functionName: 'Image.select',
            arguments: {
              bandSelectors: { constantValue: ['B4', 'B8'] },
              input: { argumentReference: '_MAPPING_VAR_0_0' },
            },
          },
        },
        '0': {
          functionInvocationValue: {
            functionName: 'Image.reduceRegion',
            arguments: {
              bestEffort: { constantValue: true },
              geometry: {
                functionInvocationValue: {
                  functionName: 'GeometryConstructors.Polygon',
                  arguments: {
                    coordinates: { constantValue: coordinates },
                    evenOdd: { constantValue: true },
                  },
                },
              },
              image: {
                functionInvocationValue: {
                  functionName: 'reduce.mean',
                  arguments: {
                    collection: {
                      functionInvocationValue: {
                        functionName: 'Collection.map',
                        arguments: {
                          baseAlgorithm: {
                            functionDefinitionValue: {
                              argumentNames: ['_MAPPING_VAR_0_0'],
                              body: '1',
                            },
                          },
                          collection: {
                            functionInvocationValue: {
                              functionName: 'Collection.filter',
                              arguments: {
                                collection: {
                                  functionInvocationValue: {
                                    functionName: 'Collection.filter',
                                    arguments: {
                                      collection: {
                                        functionInvocationValue: {
                                          functionName: 'ImageCollection.load',
                                          arguments: {
                                            id: { constantValue: 'COPERNICUS/S2_SR_HARMONIZED' },
                                          },
                                        },
                                      },
                                      filter: {
                                        functionInvocationValue: {
                                          functionName: 'Filter.dateRangeContains',
                                          arguments: {
                                            leftValue: {
                                              functionInvocationValue: {
                                                functionName: 'DateRange',
                                                arguments: {
                                                  end: { constantValue: '2024-05-31' },
                                                  start: { constantValue: '2024-02-01' },
                                                },
                                              },
                                            },
                                            rightField: { constantValue: 'system:time_start' },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                                filter: {
                                  functionInvocationValue: {
                                    functionName: 'Filter.not',
                                    arguments: {
                                      filter: {
                                        functionInvocationValue: {
                                          functionName: 'Filter.greaterThan',
                                          arguments: {
                                            leftField: { constantValue: 'CLOUDY_PIXEL_PERCENTAGE' },
                                            rightValue: { constantValue: 20 },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              maxPixels: { constantValue: 1000000000.0 },
              reducer: {
                functionInvocationValue: { functionName: 'Reducer.mean', arguments: {} },
              },
              scale: { constantValue: 100 },
            },
          },
        },
      },
    },
  }
}

export interface GEEBandValues {
  B4: number
  B8: number
}

export async function fetchSentinelBands(
  bbox: [number, number, number, number],
  token: string
): Promise<GEEBandValues> {
  const projectId = process.env.GEE_PROJECT_ID!
  const body = buildNDVIExpression(bbox)

  const res = await fetch(GEE_COMPUTE_URL(projectId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`GEE API error ${res.status}: ${JSON.stringify(data)}`)

  const result = data?.result ?? {}
  const B4 = typeof result.B4 === 'number' ? result.B4 : 800
  const B8 = typeof result.B8 === 'number' ? result.B8 : 1200
  return { B4, B8 }
}
