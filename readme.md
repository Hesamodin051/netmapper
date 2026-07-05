# 🌐 Network Mapper

**An interactive web‑based tool for automatic network discovery, real‑time device monitoring, security analysis, and topology visualization.**

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

---

## 📌 Table of Contents
- [Features](#-features)
- [Technologies](#-technologies)
- [Installation](#-installation)
- [How to Use](#-how-to-use)
- [Screenshots](#-screenshots)
- [Project Structure](#-project-structure)
- [Future Improvements](#-future-improvements)
- [License](#-license)
- [Contact](#-contact)

---

## 🚀 Features

### 🔍 Network Discovery
- **Automatic device detection** via ICMP (ping) and TCP port scanning
- **MAC address & vendor identification** using local database + Shodan API fallback
- **Smart device categorization** (Router, PC, Server, Mobile, Printer, VM, etc.)

### 📊 Real‑time Monitoring
- **Live Online/Offline status** with polling (updates every 5 seconds)
- **Latency (RTT)** measurement in milliseconds
- **Uptime tracking** showing how long each device has been online

### 🎨 Interactive Graph
- **Force‑directed graph** with D3.js
- **Subnet clustering** with color‑coded groups
- **Node dragging & automatic position saving** (persists after page refresh)
- **Zoom and pan** support
- **Link tooltips** with connection details

### 🔒 Security Analysis
- **CVE vulnerability check** via Shodan InternetDB API and NIST NVD API
- Display of open ports, CVSS scores, severity levels, and references

### 🛠️ User Controls
- **Device renaming** (click on name in details panel)
- **Manual link creation** between any two devices
- **Search & highlight** by IP, hostname, MAC, or category
- **Export results** to JSON, CSV, PNG, and PDF
- **Scan history** with save/load functionality
- **Live console** showing scan events and status changes

### 🔄 Automation
- **Scheduled auto‑scan** every 30 minutes to detect new devices

---

## 🛠️ Technologies

| Layer | Technologies |
|-------|--------------|
| **Backend** | Node.js, Express, Ping, ARP, WMI (Windows), SNMP, PowerShell |
| **Frontend** | HTML5, CSS3, JavaScript, D3.js, html2canvas, jsPDF |
| **Storage** | localStorage (browser), MAC vendor database (JSON) |
| **APIs** | Shodan InternetDB, NIST NVD |

---

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Hesamodin051/netmapper.git
   cd netmapper
