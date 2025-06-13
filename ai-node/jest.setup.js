require('@testing-library/jest-dom');
require('whatwg-fetch');

import { ReadableStream } from 'stream/web';
import { TextEncoder, TextDecoder } from 'util';

global.ReadableStream = ReadableStream;
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;


