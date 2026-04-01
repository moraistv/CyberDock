// src/firebase.js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

// Configuração do Firebase
const firebaseConfig = {
  apiKey: "AIzaSyBZ1m1kHQ0MzzTy9fuH9_Z8wz4RzWNp4nM",
  authDomain: "cyberdock-9b169.firebaseapp.com",
  databaseURL: "https://cyberdock-9b169-default-rtdb.firebaseio.com",
  projectId: "cyberdock-9b169",
  storageBucket: "cyberdock-9b169.firebasestorage.app",
  messagingSenderId: "766599550463",
  appId: "1:766599550463:web:79b002c38deda45f8343ca"
};

// Inicializa o Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

export { auth, database };