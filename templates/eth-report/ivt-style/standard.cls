\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{ivtarticle}[2014/08/16 IVT LaTeX class]
 
\LoadClass[a4paper,12pt,fleqn,onecolumn,oneside,final,bibliography=totocnumbered,numbers=noenddot,parskip=full,includeheadfoot,listof=totoc,toc=sectionentrywithdots]{scrartcl}

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% PASS PACKAGE OPTIONS
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

\RequirePackage[fleqn]{amsmath}
\RequirePackage[svgnames]{xcolor}
\RequirePackage[obeyspaces]{url}
\RequirePackage{listofitems}

%options
\DeclareOption{strc}{
    \renewcommand{\mylogos}{
        \noindent
        \begin{singlespace}
    	\begin{tabular*}{\textwidth}{@{}l@{}}
    	\includegraphics[width=\textwidth]{ivt-style/logos/strc-logo-\the\year}
        \end{tabular*}
        \end{singlespace}
    }
    \renewcommand{\titlepagedate}{}
    
   \papertype{Conference paper STRC \the\year}
}

\DeclareOption{english}{\AtEndOfClass{\main@language{english}}}
\DeclareOption{german}{
   \AtEndOfClass{\main@language{ngerman}}
    %german caption names
    \renewcaptionname{ngerman}{\contentsname}{Inhalt}
    \renewcaptionname{ngerman}{\listfigurename}{Abbildungen}
    \renewcaptionname{ngerman}{\listtablename}{Tabellen}
    \renewcaptionname{ngerman}{\figurename}{Abbildung}
    \renewcaptionname{ngerman}{\tablename}{Tabelle}
}
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}

\ProcessOptions\relax




%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% LOAD PACKAGES
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

% sets margins, borders and offset
\RequirePackage[a4paper,left=1.0in,right=1.0in,top=0.5in,bottom=0.5in,includeheadfoot]{geometry}
% fontenc: output font, inputenc:provides umlaute for german, input font
\RequirePackage[utf8]{inputenc}
\RequirePackage[T1]{fontenc}
% provides if-then-else-function
\RequirePackage{ifthen}
% language package babel
\RequirePackage[ngerman, english]{babel}
\usepackage{translations}
\RequirePackage{authblk}
% Smart space after macro
\RequirePackage{xspace}
% string manipulation
\RequirePackage{stringstrings}
\RequirePackage{textcase}
% providing expandonce command (and others):
\RequirePackage{etoolbox}
% LaTeX3 document parsing:
\RequirePackage{xparse}
% bibliography
\RequirePackage{natbib}
% AMS mathematics
\RequirePackage{amsmath}
\let\iint\relax
% adjusts font width for individual words in order to achieve better line breaking
\RequirePackage{microtype}
\fussy
% line spacing
\RequirePackage{setspace}
% Allow rotating single pages
\RequirePackage{pdflscape}

% Captions and subcaptions
\RequirePackage[figureposition=top,justification=justified,singlelinecheck=false]{caption}
\RequirePackage[singlelinecheck=on,labelformat=simple]{subcaption}

\AtBeginEnvironment{figure}{\addvspace{5mm}}
\AtBeginEnvironment{table}{\addvspace{5mm}}

\usepackage{floatrow}
\floatsetup[table]{capposition=top}
\floatsetup[figure]{capposition=top}

\DeclareCaptionFormat{myformat}{#1#2#3\hrulefill}
\captionsetup{format=myformat}

\usepackage[scaled=0.92]{helvet}
%\usepackage{sfmath}

\DeclareTranslationFallback{source}{Source}
\DeclareTranslation{English}{source}{Source}
\DeclareTranslation{ngerman}{source}{Quelle}

\newcommand{\ivtsource}[1]{ 
    \parbox{\textwidth}{
        \vspace*{0.4cm} 
        \GetTranslation{source}: {#1} 
        \vspace*{0.4cm} 
    }
}

\newcommand{\ivthline}{\hrule}


\renewcommand\thesubfigure{(\alph{subfigure})}
\renewcommand\thesubtable{(\alph{subtable})}
%linenumbering
\RequirePackage[pagewise, mathlines]{lineno}
% providing graphics
\RequirePackage{graphics}
\RequirePackage{graphicx}
% sideways figures and tables
\RequirePackage{rotating}
% figures: sometimes needed to avoid pushing the figs to the end of the text.
\def\textfraction{0.0}
\def\topfraction{0.9999}
\def\dbltopfraction{0.9999}
\def\floatpagefraction{0.8}
% tables
\RequirePackage{multicol}
\RequirePackage{multirow}
% pretty printing
\RequirePackage{listings}
%%
\lstset {
  columns=fullflexible,
  showstringspaces=false,
  basicstyle=\ttfamily\footnotesize,
  lineskip=0pt,
  breaklines=true,
  breakatwhitespace=true,
  breakindent=12pt,
  fontadjust=true,
  keywordstyle=\bfseries,
  commentstyle=\itshape,
  stringstyle=\bfseries\itshape,
  xleftmargin=0mm,
  xrightmargin=0mm,
  tabsize=2
}

%% Support for figure and table count
\RequirePackage{totcount}
\RequirePackage{calc}
\regtotcounter{figure}
\regtotcounter{table}
% Less space between enumeration lists
\usepackage{enumitem}
\setitemize{noitemsep,topsep=0pt,parsep=0pt,partopsep=0pt}
\setenumerate{noitemsep,topsep=0pt,parsep=0pt,partopsep=0pt}
\setdescription{noitemsep,topsep=0pt,parsep=0pt,partopsep=0pt}

% Typesetting-quality tables
\RequirePackage{booktabs}
% new verbatim environment
\RequirePackage{verbatim}
%% Extended color definitions
\RequirePackage{xcolor}
% Just in case (before hyperref)
\RequirePackage{longtable}
\RequirePackage{ltabptch}
\RequirePackage{nameref}
% Use hyper-refs for URLs and citations, allow line breaks for URLs include after all other packages, especially after titlesec
\RequirePackage{hyperref}
\RequirePackage{url}
% convenient referencing (after hyperref)
\RequirePackage[capitalize]{cleveref}
% tables (after hyperref):
\RequirePackage{tabularx}
% for document classes that do not provide \captionabove and \captionbelow
\providecommand{\captionabove}[2][]{\caption[#1]{#2}}
\providecommand{\captionbelow}[2][]{\caption[#1]{#2}}


\renewcommand{\sectionlinesformat}[4]{%
   \noindent \singlespacing \@hangfrom{\hskip #2#3}{#4}%
}

\renewcommand*\sectionformat{\makebox[1.2cm][l]{\noindent\thesection\autodot\hfill}}
\renewcommand*\subsectionformat{\makebox[1.2cm][l]{\noindent\thesubsection\autodot\hfill } }
\renewcommand*\subsubsectionformat{\makebox[1.2cm][l]{\noindent\thesubsubsection\autodot\hfill}}

\addtokomafont{sectionentry}{\rmfamily\normalfont}
\DeclareTOCStyleEntry[indent=0pt, numwidth=1.3em]{tocline}{table}
\DeclareTOCStyleEntry[
    indent=0pt, numwidth=1.3em
]{tocline}{figure}

\RedeclareSectionCommand[
  beforeskip=0pt,
  afterskip=0pt,
  runin=off]{section}
\RedeclareSectionCommand[
  beforeskip=0pt,
  afterskip=0pt,
  runin=off]{subsection}
\RedeclareSectionCommand[
  beforeskip=-.5\baselineskip,
  afterskip=.25\baselineskip]{subsubsection}

% fonts

\usepackage{titling}

\newcommand{\mytitle}[1]{\gdef\@mytitle{#1}}%
\newcommand{\mysubtitle}[1]{\gdef\@mysubtitle{#1}}%

\renewcommand{\author}[1]{
\ignorespaces

    \def\and{!}
    
    \setsepchar{\and}
    \readlist*\authorlist{#1}
    
    \def\authorshort{\foreachitem\a\in\authorlist{\setsepchar{\\}\readlist*\authornames{\a}\authornames[1] \\}}
    
    \def\authorlong{
    
    \setlength{\parskip}{0pt}
\setlength{\parsep}{0pt}
\setlength{\headsep}{0pt}
\setlength{\topskip}{0pt}
\setlength{\topmargin}{0pt}
\setlength{\topsep}{0pt}
\setlength{\partopsep}{0pt}

        \begin{flushleft}
        \foreachitem\a\in\authorlist{
            \begin{minipage}[t]{.49\textwidth}
                \small\a
            \vspace{10pt}
            \end{minipage}
            \hfill\allowbreak
        }
        \end{flushleft}
    }
    
}%

%\inputencoding{latin1}
\newcommand{\titlefigure}[1]{\gdef\@titlefigure{#1}}%
\newcommand{\institution}[1]{\gdef\@institution{#1}}%
\newcommand{\reportnumber}[1]{\gdef\@reportnumber{#1}}%
\newcommand{\reportyear}[1]{\gdef\@reportyear{#1}}%

\newcommand{\reportdate}[1]{\gdef\@reportdate{#1}}%
\newcommand{\reportdategerman}[1]{\gdef\@reportdategerman{#1}}%

\titlefigure{figures/MATSimLoop}
\institution{Institute for Transport Planning and Systems}


\newcommand{\keywords}[1]{\gdef\@keywords{#1}}%
\newcommand{\suggestedCitation}[1]{\gdef\@suggestedCitation{#1}}%


%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% GENERAL SETTINGS
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%



% Define the depth of numbering parts,chapter,sections and paragraphs
%   Numbers representing the depth of sectional units:
%   -1 = \part    (in book or report document classes)
%    0 = \chapter (in book or report document classes)
%    0 = \part    (in article document classes)
%    1 = \section
%    2 = \subsection
%    3 = \subsubsection
%    4 = \paragraph
%    5 = \subparagraph
\setcounter{secnumdepth}{3}
% citation style
\providecommand{\mybibstyle}{
  \setcitestyle{authoryear,round}
  \bibliographystyle{ivt-style/ivt-eng}
  }
\mybibstyle
% (no) indentation for formulas
\setlength\mathindent{0pt}
% one-half line spacing
\onehalfspacing

\newlength\titleindent
\setlength\titleindent{1cm}
 

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% TITLEPAGE SETTINGS

% Macros
\newcommand{\papertype}[1]{\gdef\@papertype{#1}}%
\papertype{Working Paper xxx}

\newcommand{\headingstitle}[1]{\gdef\@headingstitle{#1}}%
\headingstitle{\@title}





\providecommand{\titlepagedate}{
    \noindent\@ifundefined{@reportdate}{\@date}{\@reportdate}
}

\providecommand{\titlepagedategerman}{
    \noindent\@ifundefined{@reportdategerman}{\@date}{\@reportdategerman}
}

\providecommand{\titlefigureboxheight}{9cm}
\providecommand{\mylogos}{
\begin{tabular*}{\textwidth}{@{}l@{\extracolsep{\fill}}r@{}}
\includegraphics[width=2.5in]{ivt-style/logos/ivt-logo-crop} 
& \includegraphics[height=0.668in]{ivt-style/logos/eth-logo-new} \\
\end{tabular*}
}

% Titlepage definitions
\renewcommand\maketitle{
\begin{titlingpage}

  \pagenumbering{roman}
  \setcounter{page}{0}

    \setlength{\parfillskip}{0cm plus 30cm}
    \sffamily
    \hrule
    \noindent\parbox[][\titlefigureboxheight][c]{\textwidth}{
     \ifthenelse{\equal{\@titlefigure}{''}}{}{
        \begin{center}\includegraphics[width=\textwidth,totalheight=9cm,keepaspectratio=true]{\@titlefigure}\end{center}
        }
    }
    \vspace{0.1in}

    \hrule

    \begin{singlespace}
    \noindent\LARGE\textbf{\@title} \\
    \large\textbf{\@subtitle}
    \end{singlespace}
  
    \vspace{0.2in}
      
    \noindent\large\textbf{\authorshort}
    \vfill
    \begin{minipage}{\textwidth}
    \noindent
    \begin{singlespace}
    \begin{tabular*}{\textwidth}{@{}l@{\extracolsep{\fill}}r@{}}
      \textbf{\@papertype}
      & \textbf \titlepagedate  \\[1ex]
      
    \end{tabular*}
    \end{singlespace}

    \vspace{0.25in}

    \mylogos
    \end{minipage}
    \end{titlingpage}
    
    \clearpage

    \ifdefined\@theabstract
    
         % hack required for more than one invocation of \createabstract
      \ifdefined\abstractpagenumber
        \pagenumbering{roman}%
        \setcounter{page}{\abstractpagenumber}
      \fi
      %\setlength{\parfillskip}{0cm plus 5cm}
        \setlength\lineskip{0pt}
    
      \noindent\textbf{\sffamily\Large{\@title}} 
    %  \noindent\textbf{\subtitle}
       \begin{singlespace}
        \authorlong
      \end{singlespace}
    
    \begin{singlespace}
    \titlepagedate
    \end{singlespace}

      %\ifne{#1}{
        \vspace{0.25in} \noindent \textbf{\sffamily\Large{Abstract}}
      
        \begin{singlespace}
        \@theabstract
        \end{singlespace}
      %}
    
      \vfill
    
        \@ifundefined{@keywords}{}{
            \vspace{0.25in} \noindent \textbf{\sffamily\Large Keywords} \\
            \@keywords
        }
        
        \@ifundefined{@suggestedCitation}{}{
            \vspace{0.25in} \noindent \textbf{\sffamily\Large Suggested Citation} \\
            \@suggestedCitation
        }
        
      \clearpage

    \fi

    \ifdefined\@thegermanabstract
             % hack required for more than one invocation of \createabstract
          \ifdefined\abstractpagenumber
            \pagenumbering{roman}%
            \setcounter{page}{\abstractpagenumber}
          \fi
          %\setlength{\parfillskip}{0cm plus 5cm}
            \setlength\lineskip{0pt}
        
          \noindent\textbf{\sffamily\Large{\@title}} 
        %  \noindent\textbf{\subtitle}
           \begin{singlespace}
            \authorlong
          \end{singlespace}
        
          \noindent\@\titlepagedategerman
        
          %\ifne{#1}{
            \vspace{0.25in} \noindent \textbf{\sffamily\Large{Zusammenfassung}}
          
            \begin{singlespace}
            \@thegermanabstract
            \end{singlespace}
          %}
        
          \vfill
        
        \@ifundefined{@keywords}{}{
            \vspace{0.25in} \noindent \textbf{\sffamily\Large Schlagworte} \\
            \@keywords
        }
        
        \@ifundefined{@suggestedCitation}{}{
            \vspace{0.25in} \noindent \textbf{\sffamily\Large Zitierungsvorschlag} \\
            \@suggestedCitation
        }
            
      \clearpage

    \fi


 % hack required for more than one invocation of \createabstract
 \edef\abstractpagenumber{\number\value{page}}
 % don't assume user interaction
 \pagenumbering{arabic}%

}


%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% Abstract definition

\renewcommand{\abstract}[1]{\gdef\@theabstract{#1}}

\providecommand{\germanabstract}[1]{\gdef\@thegermanabstract{#1}}

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
%% Support for make parts of the document (such as page headers)
%% non-selectable
%%   (usually, you also want to ignore these parts when counting
%%    words)

\usepackage{accsupp}
\DeclareRobustCommand\squelch[1]{%
  \BeginAccSupp{method=plain,ActualText={}}#1\EndAccSupp{}%
}%
 
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% Header
 \usepackage{scrlayer-scrpage}%
  \clearscrheadfoot%
  \ohead{\slshape \footnotesize \squelch{\titlepagedate}}%
  \ihead{\slshape \footnotesize \squelch{\@headingstitle}}%
  \cfoot[\footnotesize\pagemark]{\footnotesize \squelch{\pagemark}}%
  \ofoot{}%
  \setheadsepline{0.5pt}%
  \setlength{\headheight}{1.33\baselineskip}%