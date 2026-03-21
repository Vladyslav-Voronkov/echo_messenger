import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.echoapp.messenger',
  appName: 'Echo',
  webDir: 'dist',
  server: {
    url: 'https://echo-private.com',
    cleartext: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    StatusBar: {
      style: 'Dark',
      backgroundColor: '#080810',
    },
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#080810',
      showSpinner: false,
    },
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#080810',
  },
};

export default config;
