%% ludusofficial.cls
%% LaTeX document class for LUDUS official publications
%% Version 2.0 - Optimized typography based on artnodes specifications
%% 2024-01-26

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{ludusofficial}[2024/01/26 v2.0 LUDUS Official Document Class]

%% Based on article class - two-column, two-sided (different odd/even pages)
\LoadClass[10pt,a4paper,twocolumn,twoside]{article}

%% Required packages
\RequirePackage{ifxetex}

\ifxetex
  \RequirePackage{fontspec}
  \IfFileExists{xeCJK.sty}{\RequirePackage{xeCJK}}{}
\else
  \RequirePackage[utf8]{inputenc}
  \RequirePackage[T1]{fontenc}
\fi

% Font cascade: Source Sans 3 > Helvetica Neue > LM Sans by file
\newcommand{\ludus@setupfonts}{%
  \IfFontExistsTF{Source Sans 3}{%
    \setmainfont{Source Sans 3}[Scale=1.0, Ligatures=TeX]%
    \setsansfont{Source Sans 3}[Scale=1.0, Ligatures=TeX]%
  }{%
    \IfFontExistsTF{Helvetica Neue}{%
      \setmainfont{Helvetica Neue}[Scale=1.0, Ligatures=TeX]%
      \setsansfont{Helvetica Neue}[Scale=1.0, Ligatures=TeX]%
    }{%
      \setmainfont{lmsans10-regular.otf}[
        BoldFont=lmsans10-bold.otf,
        ItalicFont=lmsans10-oblique.otf,
        BoldItalicFont=lmsans10-boldoblique.otf,
        Ligatures=TeX]%
      \setsansfont{lmsans10-regular.otf}[
        BoldFont=lmsans10-bold.otf,
        ItalicFont=lmsans10-oblique.otf,
        BoldItalicFont=lmsans10-boldoblique.otf,
        Ligatures=TeX]%
    }%
  }%
  \IfFontExistsTF{Latin Modern Mono}{%
    \setmonofont{Latin Modern Mono}[Scale=MatchLowercase]%
  }{%
    \setmonofont{lmmono10-regular.otf}[Scale=MatchLowercase]%
  }%
  \@ifpackageloaded{xeCJK}{%
    \IfFontExistsTF{Hiragino Sans}{%
      \setCJKmainfont{Hiragino Sans}%
      \setCJKsansfont{Hiragino Sans}%
      \setCJKmonofont{Hiragino Sans}%
    }{%
      \IfFontExistsTF{Microsoft YaHei}{%
        \setCJKmainfont{Microsoft YaHei}[BoldFont=Microsoft YaHei Bold]%
        \setCJKsansfont{Microsoft YaHei}%
        \setCJKmonofont{Microsoft YaHei}%
      }{}%
    }%
  }{}%
}

\ifxetex
  \ludus@setupfonts
\else
  \renewcommand{\familydefault}{\sfdefault}
\fi

\RequirePackage{geometry}
\RequirePackage{fancyhdr}
\RequirePackage{titlesec}
\RequirePackage{abstract}
\RequirePackage{xcolor}
\RequirePackage{hyperref}
\RequirePackage{graphicx}
\RequirePackage{url}
\RequirePackage{etoolbox}
\RequirePackage{ifthen}
\RequirePackage{setspace}
\RequirePackage{multicol}
\RequirePackage{environ}  % For capturing environment content

%% Page layout - two-column with narrow margins
\geometry{
    a4paper,
    top=20mm,
    bottom=20mm,
    left=15mm,
    right=15mm,
    columnsep=7mm,
    headsep=6mm,
    headheight=18pt,     % Header height adjusted for small logo
    footskip=8mm,
    includeheadfoot
}

%% Body text line spacing
% Using setspace's \setstretch
\setstretch{1.0}

%% Paragraph settings - no indent, separated by vertical space
\setlength{\parindent}{0pt}
\setlength{\parskip}{5pt plus 2pt minus 1pt}  % 5-6pt vertical spacing

%% Theme color system - enhanced contrast
% Predefined theme colors (darker and more vivid)
\definecolor{ludusblue}{RGB}{0,85,184}         % Deeper blue
\definecolor{ludusred}{RGB}{200,30,30}         % Deeper red
\definecolor{ludusgreen}{RGB}{0,130,100}       % Deeper green
\definecolor{luduspurple}{RGB}{120,50,150}     % Deeper purple
\definecolor{ludusorange}{RGB}{230,90,0}       % Deeper orange
\definecolor{luduscyan}{RGB}{0,160,180}        % Deeper cyan

% Default theme color
\colorlet{themecolor}{ludusblue}
\colorlet{linkcolor}{ludusblue}

% Theme selection command
\newcommand{\setthemecolor}[1]{%
  \ifthenelse{\equal{#1}{blue}}{%
    \colorlet{themecolor}{ludusblue}%
    \colorlet{linkcolor}{ludusblue}%
  }{}%
  \ifthenelse{\equal{#1}{red}}{%
    \colorlet{themecolor}{ludusred}%
    \colorlet{linkcolor}{ludusred}%
  }{}%
  \ifthenelse{\equal{#1}{green}}{%
    \colorlet{themecolor}{ludusgreen}%
    \colorlet{linkcolor}{ludusgreen}%
  }{}%
  \ifthenelse{\equal{#1}{purple}}{%
    \colorlet{themecolor}{luduspurple}%
    \colorlet{linkcolor}{luduspurple}%
  }{}%
  \ifthenelse{\equal{#1}{orange}}{%
    \colorlet{themecolor}{ludusorange}%
    \colorlet{linkcolor}{ludusorange}%
  }{}%
  \ifthenelse{\equal{#1}{cyan}}{%
    \colorlet{themecolor}{luduscyan}%
    \colorlet{linkcolor}{luduscyan}%
  }{}%
}

%% Predefined article type variable (must be before processing options)
\newcommand{\@articletype}{ARTICLE}  % Default value

% Document options: theme colors
\DeclareOption{blue}{\setthemecolor{blue}}
\DeclareOption{red}{\setthemecolor{red}}
\DeclareOption{green}{\setthemecolor{green}}
\DeclareOption{purple}{\setthemecolor{purple}}
\DeclareOption{orange}{\setthemecolor{orange}}
\DeclareOption{cyan}{\setthemecolor{cyan}}

% Document options: article types
\DeclareOption{fullpaper}{\renewcommand{\@articletype}{FULL PAPER}}
\DeclareOption{letter}{\renewcommand{\@articletype}{LETTER}}
\DeclareOption{poster}{\renewcommand{\@articletype}{POSTER}}
\DeclareOption{survey}{\renewcommand{\@articletype}{SURVEY}}
\DeclareOption{shortpaper}{\renewcommand{\@articletype}{SHORT PAPER}}
\DeclareOption{artpaper}{\renewcommand{\@articletype}{ART PAPER}}

\ProcessOptions\relax

%% Gray color definitions - enhanced contrast
\definecolor{darkgray}{RGB}{50,50,50}        % Deeper dark gray
\definecolor{lightgray}{RGB}{120,120,120}    % Deeper light gray

%% Hyperlink settings
\hypersetup{
    colorlinks=true,
    linkcolor=linkcolor,
    filecolor=linkcolor,
    urlcolor=linkcolor,
    citecolor=linkcolor,
    pdftitle={},
    pdfauthor={},
    pdfsubject={LUDUS Official Publication},
    pdfkeywords={},
    unicode=true,
    pdfencoding=auto,
    bookmarksnumbered=true
}

%% Document metadata
\newcommand{\@journalname}{LUDUS}
\newcommand{\@journalsubtitle}{Official Publication}
\newcommand{\@journalurl}{https://ludusofficial.site/}
\newcommand{\@institution}{ludus academik journal}
\newcommand{\@conferencename}{}
\newcommand{\@issuenumber}{}
\newcommand{\@publicationyear}{2026}
% \@articletype already defined before option processing

% Command definitions
\newcommand{\journalname}[1]{\renewcommand{\@journalname}{#1}}
\newcommand{\journalsubtitle}[1]{\renewcommand{\@journalsubtitle}{#1}}
\newcommand{\journalurl}[1]{\renewcommand{\@journalurl}{#1}}
\newcommand{\institution}[1]{\renewcommand{\@institution}{#1}}
\newcommand{\conferencename}[1]{\renewcommand{\@conferencename}{#1}}
\newcommand{\issuenumber}[1]{\renewcommand{\@issuenumber}{#1}}
\newcommand{\publicationyear}[1]{\renewcommand{\@publicationyear}{#1}}
\newcommand{\articletype}[1]{\renewcommand{\@articletype}{#1}}

%% DOI
\newcommand{\@articledoi}{}
\newcommand{\articledoi}[1]{\renewcommand{\@articledoi}{#1}}

%% Short title and author names for page headers
\newcommand{\@shorttitle}{}
\newcommand{\@shortauthor}{}
\newcommand{\shorttitle}[1]{\renewcommand{\@shorttitle}{#1}}
\newcommand{\shortauthor}[1]{\renewcommand{\@shortauthor}{#1}}

%% Header and footer settings - different for odd/even pages
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

% Even pages (left pages): shortened title on left
\fancyhead[LE]{%
    \fontsize{7.5}{9}\selectfont\sffamily\textcolor{darkgray}{\@shorttitle}%
}

% Odd pages (right pages): author names on right
\fancyhead[RO]{%
    \fontsize{7.5}{9}\selectfont\sffamily\textcolor{darkgray}{\@shortauthor}%
}

% Footer: centered page number, 8pt
\fancyfoot[C]{%
    \fontsize{8}{10}\selectfont\textcolor{darkgray}{\thepage}%
}

%% First page special header - left: institution, center: logo, right: URL (vertically centered)
\fancypagestyle{firstpage}{%
    \fancyhf{}
    \renewcommand{\headrulewidth}{0pt}
    \fancyhead[L]{%
        \raisebox{-0.3\height}{\fontsize{7.5}{9}\selectfont\sffamily\textcolor{darkgray}{\@institution}}%
    }
    \fancyhead[C]{%
        % Logo centered, height approximately 5mm (adapted to original headheight)
        \IfFileExists{../logo.png}{%
            \includegraphics[height=5mm]{../logo.png}%
        }{%
            \IfFileExists{logo.png}{%
                \includegraphics[height=5mm]{logo.png}%
            }{%
                % If logo does not exist, display placeholder text
                \fontsize{7.5}{9}\selectfont\sffamily\textcolor{darkgray}{[LOGO]}%
            }%
        }%
    }
    \fancyhead[R]{%
        \raisebox{-0.3\height}{\fontsize{7.5}{9}\selectfont\sffamily\textcolor{darkgray}{\@journalurl}}%
    }
    \fancyfoot[C]{%
        \fontsize{8}{10}\selectfont\textcolor{darkgray}{\thepage}
    }
}

%% Section title format - 11-12pt Sans-serif Bold
\titleformat{\section}
    {\fontsize{11.5}{13.8}\selectfont\sffamily\bfseries\color{themecolor}}  % Bold
    {\thesection.}
    {0.5em}
    {}

\titlespacing*{\section}
    {0pt}
    {10pt plus 2pt minus 1pt}   % Space above
    {6pt plus 1pt}               % Space below

\titleformat{\subsection}
    {\fontsize{10.5}{12.6}\selectfont\sffamily\bfseries\color{themecolor}}  % Bold
    {\thesubsection.}
    {0.5em}
    {}

\titlespacing*{\subsection}
    {0pt}
    {8pt plus 2pt minus 1pt}
    {5pt plus 1pt}

\titleformat{\subsubsection}
    {\fontsize{10}{12}\selectfont\sffamily\bfseries\color{darkgray}}  % Bold
    {\thesubsubsection.}
    {0.5em}
    {}

%% Store title information for later output
\def\@abstracttext{}
\def\@keywordstext{}

%% Redefine abstract environment using environ package to capture content
\RenewEnviron{abstract}{%
    \global\let\@abstracttext\BODY
}

%% Keywords command - store content
\newcommand{\keywords}[1]{%
    \def\@keywordstext{#1}%
}

%% Custom maketitle - using twocolumn's optional argument for full-width single column
\renewcommand{\maketitle}{%
    \twocolumn[%
        \begin{@twocolumnfalse}%
            \thispagestyle{firstpage}
            
            % Top horizontal bar (theme color) 3pt - full width
            \noindent\textcolor{themecolor}{\rule{\textwidth}{3pt}}
            \vspace{3mm}
            
            % Journal information - left-aligned, 8.5-9pt ARTICLE label
            \noindent{\fontsize{8.5}{10.2}\selectfont\sffamily\bfseries\textcolor{darkgray}{\MakeUppercase{\@articletype}}}%
            \ifdefempty{\@conferencename}{}{%
                \quad|\quad{\fontsize{8.5}{10.2}\selectfont\sffamily\textcolor{darkgray}{\MakeUppercase{\@conferencename}}}%
            }
            \vspace{4mm}
            
            % Article title - left-aligned, 21pt
            \noindent{\fontsize{21}{35}\selectfont\bfseries\sffamily\textcolor{themecolor}\@title}\par
            \vspace{4mm}
            
            % Author - left-aligned, 11pt (name bolding controlled in tex file)
            \noindent{\fontsize{11}{13.2}\selectfont\sffamily\@author}\par
            \vspace{3mm}
            
            % DOI (if available)
            \ifdefempty{\@articledoi}{}{%
                \noindent{\fontsize{8.5}{10.2}\selectfont\sffamily\textcolor{darkgray}{DOI: \@articledoi}}\par
                \vspace{2mm}
            }
            \vspace{3mm}
            
            % Abstract - full-width single column
            \ifdefempty{\@abstracttext}{}{%
                \noindent{\fontsize{11.5}{13.8}\selectfont\sffamily\bfseries\color{themecolor}Abstract}\par
                \vspace{2mm}
                {\fontsize{9}{10.35}\selectfont\sffamily\@abstracttext\par}
                \vspace{4mm}
            }
            
            % Keywords - full-width single column
            \ifdefempty{\@keywordstext}{}{%
                \noindent{\fontsize{9}{10.35}\selectfont\sffamily\textbf{Keywords:} \@keywordstext}\par
                \vspace{3mm}
            }
            
            % Bottom horizontal bar
            \vspace{3mm}
            \noindent\textcolor{lightgray}{\rule{\textwidth}{0.5pt}}
            \vspace{5mm}
        \end{@twocolumnfalse}%
    ]%
    % Set body text font to 8.5pt
    \fontsize{8.5}{9.5}\selectfont
}

%% Acknowledgments environment - 8.5-9pt
\newenvironment{acknowledgments}{%
    \section*{Acknowledgments}
    \fontsize{8.5}{9.775}\selectfont  % 8.5pt, leading 1.15
}{%
    \normalsize
}

%% Bibliography format - 9pt
\renewcommand{\refname}{References}

\renewenvironment{thebibliography}[1]{%
    \section*{\refname}%
    \fontsize{8.5}{9.5}\selectfont  % 8.5pt
    \list{\@biblabel{\@arabic\c@enumiv}}%
         {\settowidth\labelwidth{\@biblabel{#1}}%
          \leftmargin\labelwidth
          \advance\leftmargin\labelsep
          \@openbib@code
          \usecounter{enumiv}%
          \let\p@enumiv\@empty
          \renewcommand\theenumiv{\@arabic\c@enumiv}}%
    \sloppy
    \clubpenalty4000
    \@clubpenalty \clubpenalty
    \widowpenalty4000%
    \sfcode`\.\@m
}{%
    \def\@noitemerr
      {\@latex@warning{Empty `thebibliography' environment}}%
    \endlist
}

%% Footnote settings - 8pt, leading 1.1, hanging indent
\RequirePackage[hang,flushmargin]{footmisc}
\setlength{\footnotesep}{0.6em}
\renewcommand{\thefootnote}{\arabic{footnote}}
\renewcommand{\footnotelayout}{\fontsize{8}{8.8}\selectfont}  % 8pt, leading 1.1

%% Figure and table captions - 8.5-9pt
\RequirePackage{caption}
\captionsetup{
    font={small},              % Using small = 9pt (relative to 10pt base)
    labelfont=bf,
    labelsep=period,
    justification=raggedright,
    singlelinecheck=false
}

\endinput
