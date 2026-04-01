// src/composables/useApi.js
import { useAuth } from './useAuth';
import { API_BASE_URL } from '../config';

// evita // duplo ou falta de /
function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

export function useApi() {
  const { token } = useAuth();

  const request = async (endpoint, options = {}) => {
    console.log('🌐 [useApi] Fazendo requisição para:', endpoint);
    console.log('🔑 [useApi] Token presente:', !!token?.value);
    console.log('🔑 [useApi] Token valor:', token?.value ? `${token.value.substring(0, 20)}...` : 'Nenhum');
    
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token?.value) {
      headers.Authorization = `Bearer ${token.value}`;
      console.log('✅ [useApi] Token adicionado ao header');
    } else {
      console.warn('⚠️ [useApi] Nenhum token encontrado');
    }

    const url = joinUrl(API_BASE_URL, endpoint);
    console.log('📡 [useApi] URL final:', url);
    console.log('📤 [useApi] Opções da requisição:', { ...options, headers: { ...headers, Authorization: headers.Authorization ? 'Bearer [HIDDEN]' : 'Nenhum' } });
    
    try {
      const res = await fetch(url, { ...options, headers });
      console.log('📥 [useApi] Resposta recebida:', res.status, res.statusText);

      if (res.status === 204) return {};

      if (res.ok) {
        // Se a resposta é um blob (arquivo), retorna o blob diretamente
        if (options.responseType === 'blob') {
          console.log('✅ [useApi] Blob recebido com sucesso');
          return await res.blob();
        }
        
        try {
          const data = await res.json();
          console.log('✅ [useApi] Dados recebidos com sucesso');
          return data;
        } catch (e) {
          console.log('⚠️ [useApi] Resposta não é JSON válido, retornando objeto vazio');
          return {};
        }
      }

      let data = null;
      try {
        data = await res.json();
        console.error('❌ [useApi] Erro da API:', data);
      } catch (e) {
        console.error('❌ [useApi] Resposta de erro não é JSON');
        data = null;
      }

      const msg =
        (data && (data.error || data.message)) ||
        `Erro ${res.status} ${res.statusText}`;

      console.error('💥 [useApi] Erro final:', msg);

      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      err.url = url;
      throw err;
    } catch (fetchError) {
      console.error('💥 [useApi] Erro na requisição fetch:', fetchError);
      throw fetchError;
    }
  };

  return {
    get: (endpoint, options) =>
      request(endpoint, { ...options, method: 'GET' }),
    post: (endpoint, body, options) =>
      request(endpoint, {
        ...options,
        method: 'POST',
        body: JSON.stringify(body),
      }),
    put: (endpoint, body, options) =>
      request(endpoint, {
        ...options,
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    patch: (endpoint, body, options) =>
      request(endpoint, {
        ...options,
        method: 'PATCH',
        body: body ? JSON.stringify(body) : undefined,
      }),
    delete: (endpoint, options) =>
      request(endpoint, { ...options, method: 'DELETE' }),
  };
}
