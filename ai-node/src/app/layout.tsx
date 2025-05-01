'use client';

import { useState, useEffect } from 'react';
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDarkMode(isDarkMode);
  }, []);

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  return (
    <html lang="en" className={darkMode ? 'dark' : ''}>
      <body className={inter.className}>
        <button onClick={toggleDarkMode} className="fixed top-4 right-4 p-2 bg-gray-200 dark:bg-gray-800 rounded">
          {darkMode ? '🌞' : '🌙'}
        </button>
        {children}
      </body>
    </html>
  )
}