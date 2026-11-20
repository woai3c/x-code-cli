export const WHISPER_MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'

export const WHISPER_MODELS = {
  'tiny.en': {
    filename: 'ggml-tiny.en.bin',
    bytes: 77_704_715,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
  },
  tiny: {
    filename: 'ggml-tiny.bin',
    bytes: 77_691_713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  },
  'base.en': {
    filename: 'ggml-base.en.bin',
    bytes: 147_964_211,
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  },
  base: {
    filename: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  'small.en': {
    filename: 'ggml-small.en.bin',
    bytes: 487_614_201,
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  },
  small: {
    filename: 'ggml-small.bin',
    bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
} as const

export type WhisperModelName = keyof typeof WHISPER_MODELS
export type WhisperModelSpec = (typeof WHISPER_MODELS)[WhisperModelName]
