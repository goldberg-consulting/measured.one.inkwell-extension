%Author: Vikas Srivastava and Sumit Kumar Debnath
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{tmsce}[2026/01/20 TMSCE Journal Class]
 % improves justification quality
\LoadClass[11pt,a4paper]{article}

% ---------- Packages (kept minimal & stable) ----------
\RequirePackage{geometry}
\RequirePackage{fancyhdr}
\RequirePackage{titlesec}
\RequirePackage{setspace}
\RequirePackage{hyperref}
\RequirePackage{etoolbox}

% ---------- Page geometry ----------
\geometry{left=1.05in,right=1.05in,top=1.0in,bottom=1.0in}

% ---------- Journal metadata ----------
\newcommand{\journalname}{Transactions on Mathematical Sciences and Computational Engineering}

\newcommand{\vol}[1]{\def\@vol{#1}}
\newcommand{\issue}[1]{\def\@issue{#1}}
\newcommand{\yearofpub}[1]{\def\@yearofpub{#1}}
\newcommand{\pagerange}[1]{\def\@pagerange{#1}}

\newcommand{\advanceaccess}[1]{\def\@advanceaccess{#1}}
\newcommand{\doi}[1]{\def\@doi{#1}}
\newcommand{\permissions}[1]{\def\@permissions{#1}}
\newcommand{\copyrightline}[1]{\def\@copyrightline{#1}}

\newcommand{\received}[1]{\def\@received{#1}}
\newcommand{\revised}[1]{\def\@revised{#1}}
\newcommand{\accepted}[1]{\def\@accepted{#1}}
%\newcommand{\handlingeditor}[1]{\def\@handlingeditor{#1}}
\newcommand{\keywords}[1]{\def\@keywords{#1}}

% defaults (avoid "undefined control sequence")
\def\@vol{TBD}\def\@issue{TBD}\def\@yearofpub{TBD}\def\@pagerange{TBD}
\def\@advanceaccess{}\def\@doi{}\def\@permissions{}\def\@copyrightline{}
\def\@received{}\def\@revised{}\def\@accepted{}\def\@handlingeditor{}
\def\@keywords{}

% ---------- Simple author/affiliation handling (no authblk) ----------
\newcommand{\authors}[1]{\def\@tmsceauthors{#1}}
\newcommand{\affiliation}[1]{\def\@tmsceaffil{#1}}
\def\@tmsceauthors{}\def\@tmsceaffil{}

% ---------- Header/footer ----------
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0.4pt}
\fancyfoot[C]{\small \journalname\quad --\quad Vol.\ \@vol, Issue\ \@issue\ (\@yearofpub)\quad \@pagerange}
\fancyfoot[R]{\small \thepage}

% ---------- Section style ----------
\titleformat{\section}{\normalfont\bfseries\large}{\thesection.}{0.6em}{}
\titleformat{\subsection}{\normalfont\bfseries\normalsize}{\thesubsection.}{0.6em}{}

% ---------- Abstract ----------
\renewenvironment{abstract}{%
  \par\noindent\small\textbf{Abstract.}\ }{%
  \par\normalsize\vspace{0.6em}%
}


% ---------- Front-matter helpers ----------
\newcommand{\printkeywords}{%
  \ifstrempty{\@keywords}{}{%
    \noindent\small\textbf{Key words:} \@keywords\par\normalsize
  }%
}

\newcommand{\printdates}{%
  \noindent\small
  \ifstrempty{\@received}{}{\textbf{Received:} \@received\hspace{1em}}
  \ifstrempty{\@revised}{}{\textbf{Revised:} \@revised\hspace{1em}}
  \ifstrempty{\@accepted}{}{\textbf{Accepted:} \@accepted}
  \par
%  \ifstrempty{\@handlingeditor}{}{\noindent\textbf{Handling editor:} \@handlingeditor\par}
  \normalsize\vspace{0.6em}
}

% Top strip (advance access + DOI left, permissions/copyright right)
\newcommand{\tmsce@topstrip}{%
  \noindent\small
  \begin{minipage}[t]{0.62\textwidth}
    \ifstrempty{\@advanceaccess}{}{\@advanceaccess\par}
    \ifstrempty{\@doi}{}{\href{https://doi.org/\@doi}{https://doi.org/\@doi}\par}
  \end{minipage}\hfill
  \begin{minipage}[t]{0.38\textwidth}
    \ifstrempty{\@copyrightline}{}{\@copyrightline\par}
    \ifstrempty{\@permissions}{}{\@permissions\par}
  \end{minipage}
  \par\vspace{0.8em}
}

% Title block
\renewcommand{\maketitle}{%
  \thispagestyle{fancy}
  \tmsce@topstrip
  \begin{center}
    {\Large\bfseries \@title\par}
    \vspace{0.8em}
    {\normalsize \@tmsceauthors\par}
    \vspace{0.4em}
    {\small \@tmsceaffil\par}
  \end{center}
  \vspace{0.4em}
  \noindent\rule{\textwidth}{0.4pt}\par
  \vspace{0.6em}
}

% Switch to 2-column after front matter (use a journal-unique name)
\newcommand{\tmsceendfrontmatter}{%
  \vspace{0.4em}
  \noindent\rule{\textwidth}{0.4pt}\par
  \vspace{0.6em}
}


% Slightly compact look
\setstretch{1.05}
