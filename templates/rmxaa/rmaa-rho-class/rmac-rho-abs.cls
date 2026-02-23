%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% --------------------------------------------------------
% RMxAA Rho - Conference Series
% LaTeX2e Class
% Version 1.0.0 (23/01/2026)
%
% Editors-in-chief: Carlos Roman-Zuñiga 
%                   Irene Cruz-Gonzalez
%      Contributor: Luis Guillermo Jimenez-Lopez
% --------------------------------------------------------
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% --------------------------------------------------------
% This LaTeX2e class provides a template for conference 
% series that supports compact, two-column abstracts. 
% --------------------------------------------------------
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

%----------------------------------------------------------
% Class configuration
%----------------------------------------------------------

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{rmac-rho-abs}[2026/01/23 Conference Series RMxAA Rho LaTeX2e class]
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{extarticle}}
\ProcessOptions\relax
\LoadClass[twocolumn]{extarticle}

%----------------------------------------------------------
% Required packages
%----------------------------------------------------------

\RequirePackage{ragged2e}
\RequirePackage{graphicx}
\RequirePackage{xcolor}
\definecolor{rhocolor}{RGB}{0,61,121} % Blue
\usepackage{silence}
\WarningFilter{fancyhdr}{\headheight is too small}

%----------------------------------------------------------
% URLs style
%----------------------------------------------------------

\RequirePackage{url}
\RequirePackage{xurl}
\renewcommand\UrlFont{\selectfont}

%----------------------------------------------------------

\RequirePackage{hyperref}
\hypersetup{
    colorlinks=true,
    allcolors=rhocolor
}
\RequirePackage{cleveref}
\RequirePackage{bookmark}

%----------------------------------------------------------
% Fonts
%----------------------------------------------------------

\usepackage[notextcomp]{stix2}
\RequirePackage[scaled]{helvet}
\renewcommand{\ttdefault}{lmtt}

%----------------------------------------------------------
% Page layout
%----------------------------------------------------------

\RequirePackage[
    left=2.00cm, 
    right=2.00cm, 
    top=3.5cm,
    bottom=2cm, 
    headsep=30pt,
    headheight=30pt,
    % showframe
]{geometry}

%----------------------------------------------------------
% Header and footer
%----------------------------------------------------------

\RequirePackage{fancyhdr}

% New commands
\newcommand{\footerfont}{\normalfont\sffamily\fontsize{7}{9}\selectfont}
\newcommand{\leadauthor}[1]{\def\@leadauthor{#1}}
\newcommand{\doi}[1]{\def\@doi{#1}}
\newcommand{\smalltitle}[1]{\def\@smalltitle{#1}}
\newcommand{\vol}[1]{\def\@vol{#1}}
\newcommand{\pages}[1]{\def\@pages{#1}}
\newcommand{\thisyear}[1]{\def\@thisyear{#1}}

\pagestyle{fancy}

\fancyhead[L]{
    \RaggedRight
    {\bfseries\sffamily\small Revista Mexicana de Astronomía y Astrofísica Serie de Conferencias, ~\@vol,~\@pages,~(\@thisyear)}\par
    {\small\bfseries\sffamily\copyright ~\@thisyear ~Instituto de Astronomía, Universidad Nacional Autónoma de México \\ OPEN ACCESS~~{\bfseries \@doi}} 
}

\def\logofile{rmaa-rho-class/RMXAA-horizontal-amarillo.jpg}
\fancyhead[R]{%
  \makebox[0pt][r]{%
    \includegraphics[height=\headheight, keepaspectratio]{\logofile}%
  }%
}

% Footer
\fancyfoot[C]{\footerfont\bfseries\thepage}

\renewcommand{\headrulewidth}{0pt} % No header rule
\renewcommand{\footrulewidth}{0pt} % No footer rule

%----------------------------------------------------------
% Papers environment for conference series
%----------------------------------------------------------

\usepackage{setspace}
\usepackage{etoolbox}

% Store affiliations temporarily
\newcommand{\@affiltexts}{}

% Command to mark affiliations (superscript only)
\newcommand{\altaffilmark}[1]{%
  \textsuperscript{#1}%
}

% Command to define affiliation text (accumulates)
\newcommand{\altaffiltext}[2]{%
  \g@addto@macro\@affiltexts{%
    \par\fontsize{7}{9}\itshape\noindent\textsuperscript{#1}{#2}\par
  }%
}

\newenvironment{paper}{%
  % Reset variables
  \def\@affiltexts{}%
  \renewcommand{\title}[1]{\def\@paper@title{##1}}%
  \renewcommand{\author}[1]{\def\@paper@author{##1}}%
  \renewcommand{\abstract}[1]{\def\@paper@abstract{##1}}%
  \ignorespaces
}{%
  % Render the block
  \begin{center}
    \textbf{\fontsize{15}{20}\@paper@title}
    \vskip5pt
    \sffamily\fontsize{8}{7}\bfseries{\@paper@author}
  \end{center}
  \@paper@abstract
  % Print affiliations immediately after the abstract
  \par\noindent\footnoterule
  \@affiltexts
  % Divider
  \par\noindent\rule{\columnwidth}{0.4pt}\par
  \vspace{2em}
}

\endinput