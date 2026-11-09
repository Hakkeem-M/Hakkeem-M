import { createContext, useContext } from 'react';
import { createApi } from '../shared/api.js';

export const api = createApi('erp');
export const MetaCtx = createContext({});
export const useMeta = () => useContext(MetaCtx);
