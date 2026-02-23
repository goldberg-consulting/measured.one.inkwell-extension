%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% --------------------------------------------------------
% RMxAA Rho
% LaTeX Class
% Version X.X.X (11/06/2025)
%
% Authors: Carlos Román-Zúñiga & Irene Cruz-González
% Based on Rho LaTeX developed by
% Guillermo Jimenez (memo.notess1@gmail.com)
% Eduardo Gracidas (eduardo.gracidas29@gmail.com)
% --------------------------------------------------------
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% --------------------------------------------------------
% This LaTeX class file defines the document layout and behavior. Based on the original rho LaTeX class work.
% --------------------------------------------------------
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

%----------------------------------------------------------
% CLASS CONFIGURATION
%----------------------------------------------------------

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{rmaa-rho-class/rmaa-rho}[2025/06/11 RMxAA Rho LaTeX class]
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{extarticle}}
\ProcessOptions\relax
\LoadClass[twocolumn]{extarticle}

% --- Opcional: Guarda definiciones originales para evitar conflictos ---
\let\oldtablecaption\tablecaption  % Reserva el comando original
\let\oldtablenotemark\tablenotemark
\let\oldtablenotetext\tablenotetext

% --- Continúa con el resto de paquetes ---
% \AtBeginDocument{\linenumbers}  % controlled by template via YAML frontmatter
\AtEndOfClass{\let\CheckCommand\providecommand\RequirePackage{microtype}}

%----------------------------------------------------------
% REQUIRED PACKAGES
%----------------------------------------------------------

\RequirePackage[utf8]{inputenc}
\RequirePackage{array} 
\RequirePackage{etoolbox}
\RequirePackage[framemethod=tikz]{mdframed}
\RequirePackage{titling}
\RequirePackage{lettrine}
\RequirePackage[switch]{lineno}
\renewcommand{\LineNumber}{\normalfont\sffamily\color{black!50}\arabic{linenumber}}
\RequirePackage{microtype}
\RequirePackage[bottom,hang,flushmargin,ragged]{footmisc}
\RequirePackage{fancyhdr}
\RequirePackage{xifthen}
\RequirePackage[export]{adjustbox}
\RequirePackage{adforn}
\RequirePackage{lastpage}
\RequirePackage[explicit]{titlesec}
\RequirePackage{booktabs}
\RequirePackage{caption}
\RequirePackage{setspace}
\RequirePackage{iflang}
\RequirePackage{listings}
\RequirePackage{lipsum}
\RequirePackage{fontawesome5}       % For icons
\RequirePackage{chemfig}            % Chemical structures
\RequirePackage{circuitikz}         % Circuits schematics
\RequirePackage{matlab-prettifier}
\RequirePackage{listings}
\RequirePackage{csquotes}
\RequirePackage{ragged2e}
\RequirePackage{ccicons}
\RequirePackage{imakeidx}
\RequirePackage{subcaption}
\RequirePackage{stfloats} 
\RequirePackage{authblk}

%Need to make better tables
\usepackage{pdflscape}
\usepackage{rotating}
\usepackage{multirow} 
\usepackage{longtable}

%Paquete para alineación de columnas
\usepackage{balance}
\usepackage{flushend}

%ORCID
\usepackage{orcidlink}


\hyphenpenalty=10000

%----------------------------------------------------------
% RHO CUSTOM PACKAGES (location/name)
%----------------------------------------------------------

\RequirePackage{rmaa-rho-class/rhobabel}
\RequirePackage{rmaa-rho-class/rhoenvs}

%----------------------------------------------------------
% PAGE LAYOUT
%----------------------------------------------------------

\RequirePackage[
    left=2.00cm, 
    right=2.00cm, 
    top=2cm, 
    bottom=2cm, 
    headsep=0.75cm
]{geometry}

\setlength{\columnsep}{15pt}

%----------------------------------------------------------
% PACKAGES FOR FIGURES
%----------------------------------------------------------

\RequirePackage{graphicx}
\RequirePackage{here}

%----------------------------------------------------------
% PACKAGES FOR BOXES
%----------------------------------------------------------

\RequirePackage{adjustbox}
\RequirePackage{colortbl}
\RequirePackage{tcolorbox}

%----------------------------------------------------------
% MATH PACKAGES
%----------------------------------------------------------

%!TEX In case of using another font that is not stix2 uncomment 'amssymb'

\RequirePackage{amsmath}
\RequirePackage{amsfonts}
\RequirePackage{mathtools}
% \RequirePackage{amssymb}

% Equation skip value
\newlength{\eqskip}\setlength{\eqskip}{8pt}
\expandafter\def\expandafter\normalsize\expandafter{%
    \normalsize%
    \setlength\abovedisplayskip{\eqskip}%
    \setlength\belowdisplayskip{\eqskip}%
    \setlength\abovedisplayshortskip{\eqskip-\baselineskip}%
    \setlength\belowdisplayshortskip{\eqskip}%
}

%----------------------------------------------------------
% FONTS
%----------------------------------------------------------

\usepackage[notextcomp]{stix2}
\RequirePackage[scaled]{helvet}
\renewcommand{\ttdefault}{lmtt}

%----------------------------------------------------------
% URLs STYLE
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
% ITEMS
%----------------------------------------------------------

\RequirePackage{enumitem}
\setlist{noitemsep}

%----------------------------------------------------------
% FIRST PAGE-, HEADER AND FOOTER
%----------------------------------------------------------

% New commands
\newcommand{\footerfont}{\normalfont\sffamily\fontsize{7}{9}\selectfont}
\newcommand{\leadauthor}[1]{\def\@leadauthor{#1}}
\newcommand{\smalltitle}[1]{\def\@smalltitle{#1}}
\newcommand{\vol}[1]{\def\@vol{#1}}

\pagestyle{fancy}
   \pagenumbering{arabic}

% First page style
\fancypagestyle{firststyle}{
    \fancyfoot[R]{
        {\ifx\@smalltitle\undefined\else\footerfont\@smalltitle\hspace{10pt}\fi}
        {\footerfont\textbf\thepage\textendash\pageref{LastPage}}
    }
    \fancyfoot[L]{\ifx\@footinfo\undefined\else\footerfont\@footinfo\fi}
    \fancyfoot[C]{}
    \fancyhead[C,R,L]{}
}

% Header
\fancyhead[RO,LE]{\ifx\@title\undefined\else\footerfont\@title\fi}
\fancyhead[RE,LO]{\ifx\@leadauthor\undefined\else\footerfont\@leadauthor\fi}

% Footer
\fancyfoot[C]{\footerfont\bfseries\thepage}

\renewcommand{\headrulewidth}{0pt} % No header rule
\renewcommand{\footrulewidth}{0pt} % No footer rule

%----------------------------------------------------------
% RHO START ~ LETTRINE
%----------------------------------------------------------

\newcommand{\dropcapfont}{\color{rhocolor}\bfseries\fontsize{25pt}{28pt}\selectfont}
\newcommand{\RMxAAstart}[1]{\lettrine[lines=2,lraise=0,findent=2pt, nindent=0em]{{\dropcapfont{#1}}}{}}

%----------------------------------------------------------
% SET RMXAA TEMPLATE (ARTICLE OR CONFERENCE)
%----------------------------------------------------------

\newcommand{\RMxAC}{RMxAC}
\newcommand{\RMxAA}{RMxAA}

\newcommand{\RMxAAtemplatetype}[1]{%
    \ifdefequal{#1}{\RMxAC}{%  % Si se selecciona RMxAC (conferencias)
        % Configuración para conferencias (amarillo)
        \def\rhotheme{rhoyellow}% Color amarillo
        \def\logofile{rmaa-rho-class/RMXAA-horizontal-amarillo.jpg}% Logo amarillo
        \def\templatetype{RMxAC}% Tipo de plantilla
    }{%  % Caso predeterminado: RMxAA (artículos)
        % Configuración predeterminada para artículos (azul)
        \def\rhotheme{rhocolor}% Color azul
        %\def\logofile{rmaa-rho-class/LogoRMxAazul.jpg}% Logo azul
        \def\logofile{rmaa-rho-class/rmxaa-horizontal-azul.png}% Logo azul
        \def\templatetype{RMxAA}% Tipo de plantilla
    }%
}
%----------------------------------------------------------
% CORRESPONDING AUTHOR SECTION
%----------------------------------------------------------

% New commands
\newcommand{\rhoinfofont}{\color{black}\normalfont\sffamily\linespread{1}\fontsize{7.8}{9}\selectfont}
\newcommand{\received}[1]{\def\@received{#1}}
\newcommand{\revised}[1]{\def\@revised{#1}}
\newcommand{\accepted}[1]{\def\@accepted{#1}}
\newcommand{\published}[1]{\def\@published{#1}}
\newcommand{\corres}[1]{\def\@corres{#1}}
\newcommand{\email}[1]{\def\@email{#1}}
\newcommand{\doi}[1]{\def\@doi{#1}}
\newcommand{\license}[1]{\def\@license{#1}}
\newcommand{\pages}[1]{\def\@pages{#1}}
\newcommand{\thisyear}[1]{\def\@thisyear{#1}}

\newcommand{\rhoinfo}{
    \rhoinfofont
        \vskip5pt
            {\ifx\@corres\undefined\else\textcolor{rhocolor}{\bfseries\ignorespaces\correslanguage}\@corres\fi} 
            {\ifx\@email\undefined\else\textcolor{rhocolor}{\itshape\ignorespaces\emaillanguage}\@email\fi\par}
            %{\ifx\@doi\undefined\else\textcolor{rhocolor}{\bfseries DOI: }\@doi\fi\par}
            {\ifx\@received\undefined\else\textcolor{rhocolor}{\bfseries\ignorespaces\receivedlanguage}\@received\hspace{10pt}\fi}
            {\ifx\@revised\undefined\else\textcolor{rhocolor}{\bfseries\ignorespaces\revisedlanguage}\@revised\hspace{10pt}\fi} 
            {\ifx\@accepted\undefined\else\textcolor{rhocolor}{\bfseries\ignorespaces\acceptedlanguage}\@accepted\hspace{10pt}\fi}
            {\ifx\@published\undefined\else\textcolor{rhocolor}{\bfseries\ignorespaces\publishedlanguage}\@published\fi\par}
%                \vskip3pt
%            {\@license\par}
        \vskip1pt
        \rule{\textwidth}{0.3pt}
}

%----------------------------------------------------------
% ABSTRACT STYLE
%----------------------------------------------------------

% Abstract text style new commands
\newcommand{\keywords}[1]{\def\@keywords{#1}}
\newcommand{\pclave}[1]{\def\@pclave{#1}}
\newcommand{\absfont}{\noindent\color{black}\justifying\normalfont\sffamily\linespread{1}\fontsize{8.5}{11}\selectfont}
\newcommand{\absheadfont}{\color{\rhotheme}\normalfont\sffamily\fontsize{9}{11}\selectfont}
\newcommand{\keywordsfont}{\noindent\normalfont\sffamily\itshape\linespread{1}\fontsize{7.8}{9}\selectfont}
\newcommand{\keywordheadfont}{\normalfont\sffamily\fontsize{7.8}{9}\selectfont\bfseries}

% Abstract definition
\def\xabstract{abstract}
\long\def\abstract#1\end#2{
    \def\two{#2}\ifx\two\xabstract
    \long\gdef\theabstract{\ignorespaces#1}
    \def\go{\end{abstract}}
\else
    #1\end{#2}
    \gdef\theabstract{\vskip12pt 
    \vskip12pt}
    \let\go\relax\fi
\go}

% Resumen definition
\def\xresumen{resumen}
\long\def\resumen#1\end#2{
    \def\two{#2}\ifx\two\xresumen
    \long\gdef\elresumen{\ignorespaces#1}
    \def\go{\end{resumen}}
\else
    #1\end{#2}
    \gdef\elresumen{\vskip12pt 
    \vskip12pt}
    \let\go\relax\fi
\go}

% Rho class abstract style 
\newcommand{\rhoabstract}{
    \begin{tcolorbox}[colback=\rhotheme!22, arc=0pt, boxrule=0pt, left=5pt, right=5pt, top=5pt, bottom=5pt]
        \ifx\@keywords\undefined
            \absheadfont\bfseries\abstractname\vskip0.5em\absfont\theabstract\vskip10pt
        \else
            \absheadfont\bfseries\abstractname\vskip0.5em\absfont\theabstract\vskip10pt
%            \keywordsfont\keywordname\hspace{0.1em}\keywordsfont\@keywords
        \fi
    \end{tcolorbox}
}

% Rho class Spanish resumen 
\newcommand{\rhoresumen}{
    \begin{tcolorbox}[colback=\rhotheme!22, arc=0pt, boxrule=0pt, left=5pt, right=5pt, top=5pt, bottom=5pt]
        \ifx\@pclave\undefined
            \absheadfont\bfseries\resumenname\vskip0.5em\absfont\elresumen\vskip10pt
        \else
            \absheadfont\bfseries\resumenname\vskip0.5em\absfont\elresumen\vskip10pt
            \keywordsfont\pclavename\hspace{0.1em}\keywordsfont\@pclave
        \fi
    \end{tcolorbox}
}
%----------------------------------------------------------
% RESUMEN-, ABTRACT-, NEWBOOL
%----------------------------------------------------------

\newbool{rho-resumen}
\newbool{rho-abstract}


%----------------------------------------------------------
% TITLE STYLE
%----------------------------------------------------------

% New commands
\newcommand{\dates}[1]{\def\@dates{#1}}
\newcommand{\datesfont}{\fontsize{7.5}{9}\selectfont}

\renewcommand{\@maketitle}{
    \bgroup
        \setlength{\parindent}{0pt}
            \begin{minipage}[t]{\textwidth} 
                \RaggedRight
                {\bfseries\sffamily\small Revista Mexicana de Astronomía y Astrofísica,~\@vol,~\@pages,~(\@thisyear)}\par
                \vspace{2pt}
                {\small\bfseries\sffamily\copyright ~\@thisyear ~Instituto de Astronomía, Universidad Nacional Autónoma de México \\ OPEN ACCESS~~{\bfseries \@doi}} 
            \end{minipage}
        \hfill
            \begin{minipage}[t]{\textwidth} 
                \RaggedLeft
                \vspace*{-3.39\baselineskip}
                \IfFileExists{\logofile}{%
                  \includegraphics[width=1.45in, height=0.5031in]{\logofile}%
                }{}
            \end{minipage}
        \vskip15pt
            {\RaggedRight\bfseries\fontsize{20}{25}\selectfont\@title\par}
        \vskip10pt
            {\RaggedRight\@author\par}
            \vskip7pt
        \ifx\@keywords\undefined
            \vskip5pt
        \else
            \keywordsfont\keywordname\hspace{0.1em}\keywordsfont\@keywords\vskip10pt
        \fi            
        \vskip5pt            
        {\ifbool{rho-abstract}{\rhoabstract}{}}
        {\ifbool{rho-resumen}{\rhoresumen}{}}
%           {\rhoabstract}
%            {\rhoresumen}
            {\RaggedRight\rhoinfo}
    \egroup
    \vskip8pt
}

%----------------------------------------------------------
% AFFILIATION SETUP
%----------------------------------------------------------

\setlength{\affilsep}{9pt}
\renewcommand\Authfont{\fontsize{11}{11}\bfseries\sffamily\selectfont}
\renewcommand\Affilfont{\fontsize{8.5}{9}\it\selectfont}
\renewcommand\AB@affilsep{\reset@font\protect\Affilfont}
\renewcommand\AB@affilsepx{\reset@font\protect\\\protect\Affilfont}
% \renewcommand\AB@affilsepx{, \protect\Affilfont}

% Authands language
\renewcommand\Authand{\ignorespaces\andlanguage }
\renewcommand\Authands{\ignorespaces\andlanguage }

%----------------------------------------------------------
% SECTION STYLE
%----------------------------------------------------------

\setcounter{secnumdepth}{5}

\titleformat{\section}
    {\color{rhocolor}\sffamily\large\bfseries}
    {\thesection.}
    {0.5em}
    {#1}
    []

\titleformat{name=\section,numberless}[block]
    {\color{rhocolor}\sffamily\large\bfseries}
    {}
    {0em}
    {\tikz\draw[rhocolor, fill=rhocolor] (0,0) rectangle (6.6pt,6.6pt); \hspace{2.5pt} {#1}}
    []
  
\titleformat{\subsection}[block]
    {\sffamily\bfseries}
    {\thesubsection.}
    {0.5em}
    {#1}     
    []
  
\titleformat{\subsubsection}[block] 
    {\small\sffamily\bfseries\itshape}
    {\thesubsubsection.}
    {0.5em}
    {#1}      
    []    
  
\titleformat{\paragraph}[runin]
    {\small\bfseries}
    {}
    {0em}
    {#1} 
  
\titlespacing*{\section}{0pc}{3ex \@plus4pt \@minus3pt}{5pt}
\titlespacing*{\subsection}{0pc}{1ex}{2pt}
\titlespacing*{\subsubsection}{0pc}{1ex}{2pt}
\titlespacing*{\paragraph}{0pc}{1ex}{12pt}

%----------------------------------------------------------
% TABLE OF CONTENTS
%----------------------------------------------------------

\newlength{\tocsep} 
\setlength\tocsep{1.5pc} % Sets the indentation of the sections in the table of contents
\setcounter{tocdepth}{5} % Three levels in the table of contents section: sections, subsections and subsubsections

\usepackage{titletoc}
\contentsmargin{0cm}

%!TEX If using numberless sections we recomend to change the values 

\titlecontents{section}[\tocsep] % \setlength\tocsep{0c}
    {\addvspace{4pt}\sffamily\selectfont\bfseries}
    {\contentslabel[\thecontentslabel]{\tocsep}}
    {}
    {\hfill\thecontentspage}
    []

\titlecontents{subsection}[3pc] % 1pc
    {\addvspace{4pt}\small\sffamily\selectfont}
    {\contentslabel[\thecontentslabel]{\tocsep}}
    {}
    {\ \titlerule*[.5pc]{.}\ \thecontentspage}
    []

\titlecontents*{subsubsection}[3pc] % 1pc
    {\footnotesize\sffamily\selectfont}
    {}
    {}
    {}
    [\ \textbullet\ ]

%----------------------------------------------------------
% FIGURE-, TABLE-, LISTINGS- CAPTION STYLE
%----------------------------------------------------------

% General captions
\RequirePackage[
    labelfont={bf,sf},
    list=no,
    labelsep=period,
    singlelinecheck=off,
    font=small,
    justification=centering
]{caption}

% Table caption
\captionsetup[table]{position=below}
\newcommand{\tabletext}[1]{{\setlength{\leftskip}{9pt}\fontsize{7}{9}\vskip2pt\selectfont#1}}

% Listings caption
\newcommand{\captioncodelanguage}{
    \iflanguage{spanish}{
        {C\'odigo}%
    }{%
        {Code}%
    }%
}
\captionsetup[lstlisting]{font=small, labelfont={bf,sf}, belowskip=3pt, position=below, labelsep=period}
\renewcommand\lstlistingname{\captioncodelanguage}
\renewcommand\lstlistlistingname{\captioncodelanguage}

%----------------------------------------------------------
% LISTINGS STYLE
%----------------------------------------------------------

% Defined colors for listings environment
\definecolor{rhocodeback}{RGB}{248, 248, 248}  
% \definecolor{rhocodeback}{RGB}{255, 255, 255}     % Alternative back color
\definecolor{rhocodecomment}{RGB}{1, 136, 0}
\definecolor{rhocodekey}{RGB}{53, 53, 128}
\definecolor{rhocodestring}{RGB}{122, 36, 47}
\definecolor{rhogray}{RGB}{0.5,0.5,0.5}
\definecolor{rhoredmatlab}{RGB}{199, 78, 0}
\definecolor{rhoblue}{RGB}{43, 43, 255}

% Rho codes style
\lstdefinestyle{rhocoding}{
    backgroundcolor=\color{rhocodeback},   
    commentstyle=\color{rhocodecomment},
    keywordstyle=\color{rhocodekey},
    numberstyle=\tiny\color{rhogray},
    stringstyle=\color{rhocodestring},
    basicstyle=\small\ttfamily,
    breaklines=true,   
    breakatwhitespace=false,
    captionpos=b,                    
    keepspaces=true,                 
    numbers=left,				 	% if "none" change the values  
    numbersep=8pt,    				% 0pt              
    showspaces=false,                
    showstringspaces=false,
    showtabs=false,                  
    tabsize=2,
    aboveskip=12pt,
    belowskip=8pt,
    xleftmargin=10pt,				% 0pt
    rulecolor=\color{rhogray},
    frame=single,
    columns=fullflexible,
    postbreak=\mbox{\small\textcolor{rhogray}{$\hookrightarrow$}\space},
    literate=
        {0}{{\textcolor{rhoblue}{0}}}{1}
        {1}{{\textcolor{rhoblue}{1}}}{1}
        {2}{{\textcolor{rhoblue}{2}}}{1}
        {3}{{\textcolor{rhoblue}{3}}}{1}
        {4}{{\textcolor{rhoblue}{4}}}{1}
        {5}{{\textcolor{rhoblue}{5}}}{1}
        {6}{{\textcolor{rhoblue}{6}}}{1}
        {7}{{\textcolor{rhoblue}{7}}}{1}
        {8}{{\textcolor{rhoblue}{8}}}{1}
        {9}{{\textcolor{rhoblue}{9}}}{1}    
}

% Matlab
\lstset{
    language=Matlab,
    rulecolor=\color{rhogray},
    emph=[1]{for,end,break},
    emphstyle=[1]\color{rhoredmatlab},
}

\lstset{style=rhocoding}

%----------------------------------------------------------
% FOOTNOTE STYLE
%----------------------------------------------------------

\definecolor{black50}{gray}{0.5}
\renewcommand*{\footnotelayout}{\normalfont\fontsize{6}{8}}
\renewcommand{\footnoterule}{
    \kern -3pt
    {\color{black50} \hrule width 75pt height 0.25pt}
    \kern 2.5pt
}

%----------------------------------------------------------
% BIBLATEX
%----------------------------------------------------------

\usepackage[authoryear,numbers]{natbib}
\bibliographystyle{aasjournal}
% Minimizes line spacing for references
\setlength{\bibsep}{0.25pt}

% ----------------------------------------------------------
% MACRO DEFINITIONS
% ----------------------------------------------------------

\newcommand{\RMAA}{RMxAA}
\newcommand{\RMAAlong}{Revista Mexicana de Astronom\'{\i}a y Astrof\'{\i}sica}
\newcommand{\RMAASC}{RMxAC)}
\newcommand{\RMAASClong}{\RMAA\ Serie de Conferencias}
\newcommand{\ibidrule}{\rule[-0.03cm]{4.7em}{.01cm}.\ }
%\newcommand{\ThisVolume}[1]{%
%  \@year, \if@proceedings\RMAASC\else\RMAA\fi, \@volume,
 % \if@book\oldpageref{#1:RMAAFirstPage}\else 000\fi\ (this volume)}
\newcommand{\etal}{et al.\@}
\def\acknowledgments{\vskip 3ex plus .8ex minus .4ex}
\let\acknowledgements=\acknowledgments                  % second spelling
\let\jnl@style=\rm
\def\ref@jnl#1{{\jnl@style#1}}
\DeclareRobustCommand\aj{\ref@jnl{AJ}}
\DeclareRobustCommand\araa{\ref@jnl{ARA\&A}}
\DeclareRobustCommand\apj{\ref@jnl{ApJ}}
\DeclareRobustCommand\apjl{\ref@jnl{ApJ}}
\DeclareRobustCommand\apjs{\ref@jnl{ApJS}}
\DeclareRobustCommand\ao{\ref@jnl{Appl.~Opt.}}
\DeclareRobustCommand\apss{\ref@jnl{Ap\&SS}}
\DeclareRobustCommand\aap{\ref@jnl{A\&A}}
\DeclareRobustCommand\aapr{\ref@jnl{A\&A~Rev.}}
\DeclareRobustCommand\aaps{\ref@jnl{A\&AS}}
\DeclareRobustCommand\azh{\ref@jnl{AZh}}
\DeclareRobustCommand\baas{\ref@jnl{BAAS}}
\DeclareRobustCommand\jrasc{\ref@jnl{JRASC}}
\DeclareRobustCommand\memras{\ref@jnl{MmRAS}}
\DeclareRobustCommand\mnras{\ref@jnl{MNRAS}}
\DeclareRobustCommand\pra{\ref@jnl{Phys.~Rev.~A}}
\DeclareRobustCommand\prb{\ref@jnl{Phys.~Rev.~B}}
\DeclareRobustCommand\prc{\ref@jnl{Phys.~Rev.~C}}
\DeclareRobustCommand\prd{\ref@jnl{Phys.~Rev.~D}}
\DeclareRobustCommand\pre{\ref@jnl{Phys.~Rev.~E}}
\DeclareRobustCommand\prl{\ref@jnl{Phys.~Rev.~Lett.}}
\DeclareRobustCommand\pasp{\ref@jnl{PASP}}
\DeclareRobustCommand\pasj{\ref@jnl{PASJ}}
\DeclareRobustCommand\qjras{\ref@jnl{QJRAS}}
\DeclareRobustCommand\skytel{\ref@jnl{S\&T}}
\DeclareRobustCommand\solphys{\ref@jnl{Sol.~Phys.}}
\DeclareRobustCommand\sovast{\ref@jnl{Soviet~Ast.}}
\DeclareRobustCommand\ssr{\ref@jnl{Space~Sci.~Rev.}}
\DeclareRobustCommand\zap{\ref@jnl{ZAp}}
\DeclareRobustCommand\nat{\ref@jnl{Nature}}
\DeclareRobustCommand\iaucirc{\ref@jnl{IAU~Circ.}}
\DeclareRobustCommand\aplett{\ref@jnl{Astrophys.~Lett.}}
\DeclareRobustCommand\apspr{\ref@jnl{Astrophys.~Space~Phys.~Res.}}
\DeclareRobustCommand\bain{\ref@jnl{Bull.~Astron.~Inst.~Netherlands}}
\DeclareRobustCommand\fcp{\ref@jnl{Fund.~Cosmic~Phys.}}
\DeclareRobustCommand\gca{\ref@jnl{Geochim.~Cosmochim.~Acta}}
\DeclareRobustCommand\grl{\ref@jnl{Geophys.~Res.~Lett.}}
\DeclareRobustCommand\jcp{\ref@jnl{J.~Chem.~Phys.}}
\DeclareRobustCommand\jgr{\ref@jnl{J.~Geophys.~Res.}}
\DeclareRobustCommand\jqsrt{\ref@jnl{J.~Quant.~Spec.~Radiat.~Transf.}}
\DeclareRobustCommand\memsai{\ref@jnl{Mem.~Soc.~Astron.~Italiana}}
\DeclareRobustCommand\nphysa{\ref@jnl{Nucl.~Phys.~A}}
\DeclareRobustCommand\physrep{\ref@jnl{Phys.~Rep.}}
\DeclareRobustCommand\physscr{\ref@jnl{Phys.~Scr}}
\DeclareRobustCommand\planss{\ref@jnl{Planet.~Space~Sci.}}
\DeclareRobustCommand\procspie{\ref@jnl{Proc.~SPIE}}
\let\astap=\aap
\let\apjlett=\apjl
\let\apjsupp=\apjs
\let\applopt=\ao
\def\phn{\phantom{0}}
\def\phd{\phantom{.}}
\def\phs{\phantom{\ensuremath{-}}}
\def\phm#1{\phantom{#1}}
% Special symbols
%%\def\sun{\hbox{$\odot$}}
\DeclareRobustCommand\sun{\ensuremath{\odot}}
%%\def\earth{\hbox{$\oplus$}}
\DeclareRobustCommand\earth{\ensuremath{\oplus}}
%%\def\lesssim{\mathrel{\hbox{\rlap{\hbox{\lower4pt\hbox{$\sim$}}}\hbox{$<$}}}}
%%\def\gtrsim{\mathrel{\hbox{\rlap{\hbox{\lower4pt\hbox{$\sim$}}}\hbox{$>$}}}}
\DeclareRobustCommand\lesssim{\mathrel{\hbox{\smaller\smaller\rlap{\hbox{\lower3pt\hbox{$\sim$}}}\raise1.5pt\hbox{$<$}}}}
\DeclareRobustCommand\gtrsim{\mathrel{\hbox{\smaller\smaller\rlap{\hbox{\lower3pt\hbox{$\sim$}}}\raise1.5pt\hbox{$>$}}}}
%%\def\lta{\mathrel{\spose{\lower 3pt\hbox{$\mathchar"218$}}
%%     \raise 2.0pt\hbox{$\mathchar"13C$}}}
%%\def\gta{\mathrel{\spose{\lower 3pt\hbox{$\mathchar"218$}}
%%     \raise 2.0pt\hbox{$\mathchar"13E$}}}
%\newcommand\degr{\hbox{$^\circ$}}
\DeclareRobustCommand\degr{\hbox{$^\circ$}}
\DeclareRobustCommand\sq{\hbox{\rlap{$\sqcap$}$\sqcup$}}
%%\def\arcdeg{\hbox{$^\circ$}}
%%\def\arcmin{\hbox{$^\prime$}}
%%\def\arcsec{\hbox{$^{\prime\prime}$}}
\DeclareRobustCommand\arcdeg{\ensuremath{^\circ}}
\DeclareRobustCommand\arcmin{\ensuremath{^\prime}}
\DeclareRobustCommand\arcsec{\ensuremath{^{\prime\prime}}}
%%\def\fd{\hbox{$.\!\!^{\rm d}$}}
%%\def\fh{\hbox{$.\!\!^{\rm h}$}}
%%\def\fm{\hbox{$.\!\!^{\rm m}$}}
%%\def\fs{\hbox{$.\!\!^{\rm s}$}}
%%\def\fdg{\hbox{$.\!\!^\circ$}}
%%\def\farcm{\hbox{$.\mkern-4mu^\prime$}}
%%\def\farcs{\hbox{$.\!\!^{\prime\prime}$}}
%%\def\fp{\hbox{$.\!\!^{\scriptscriptstyle\rm p}$}}
\DeclareRobustCommand\fd{\ensuremath{.\!\!^\mathrm{d}}}
\DeclareRobustCommand\fh{\ensuremath{.\!\!^\mathrm{h}}}
\DeclareRobustCommand\fm{\ensuremath{.\!\!^\mathrm{m}}}
\DeclareRobustCommand\fs{\ensuremath{\mkern0.5mu.\mkern-5mu^\mathrm{s}\mkern-1mu}}
\DeclareRobustCommand\fdg{\ensuremath{.\!\!^\circ}}
\DeclareRobustCommand\farcm{\ensuremath{.\mkern-4mu^\prime}}
\DeclareRobustCommand\farcs{\ensuremath{\mkern1mu.\mkern-6mu^{\prime\prime}\mkern-1.5mu}}
%%\DeclareRobustCommand\farcs{\ensuremath{.\!\!^{\prime\prime}}}
\DeclareRobustCommand\fp{\ensuremath{.\!\!^{\scriptscriptstyle\rm p}}}
%%\def\micron{\hbox{$\mu$m}}
\DeclareRobustCommand\micron{\ensuremath{\mu\mathrm{m}}}
\let\la=\lesssim
\let\ga=\gtrsim
%%\def\case#1#2{\hbox{$\frac{#1}{#2}$}}
%%\def\slantfrac#1#2{\hbox{$\,^#1\!/_#2$}}
%%\def\onehalf{\slantfrac{1}{2}}
%%\def\onethird{\slantfrac{1}{3}}
%%\def\twothirds{\slantfrac{2}{3}}
%%\def\onequarter{\slantfrac{1}{4}}
%%\def\threequarters{\slantfrac{3}{4}}
\DeclareRobustCommand\case[2]{\ensuremath{\frac{#1}{#2}}}
\DeclareRobustCommand\slantfrac[2]{\ensuremath{\,^#1\!/_#2}}
\DeclareRobustCommand\onehalf{\slantfrac{1}{2}}
\DeclareRobustCommand\onethird{\slantfrac{1}{3}}
\DeclareRobustCommand\twothirds{\slantfrac{2}{3}}
\DeclareRobustCommand\onequarter{\slantfrac{1}{4}}
\DeclareRobustCommand\threequarters{\slantfrac{3}{4}}
%%\def\ubvr{\hbox{$U\!BV\!R$}}
%%\def\ub{\hbox{$U\!-\!B$}}
%%\def\bv{\hbox{$B\!-\!V$}}
%%\def\vr{\hbox{$V\!-\!R$}}
%%\def\ur{\hbox{$U\!-\!R$}}
\DeclareRobustCommand\ubvr{\ensuremath{U\!BV\!R}}
\DeclareRobustCommand\Color[2]{%
  \ensuremath{%
    #1\!\ifx#1V\!\fi-\!#2
  }}
\DeclareRobustCommand\ub{\Color{U}{B}}
\DeclareRobustCommand\bv{\Color{B}{V}}
\DeclareRobustCommand\vr{\Color{V}{R}}
\DeclareRobustCommand\ur{\Color{U}{R}}
%% New version of the \ion command, that actually works!
\DeclareRobustCommand\ion[2]{%
  \mbox{#1\kern0.2em%
    \smaller\rmfamily%
    \edef\@tempa{\@car#2\@nil}%
    \ifcat1\@tempa%
    \@Roman{#2}%
    \else%
    \uppercase{#2}%
    \fi}}
\newcounter{IonStage}
\DeclareRobustCommand\plainion[2]{\setcounter{IonStage}{#2}#1 \Roman{IonStage}}
%%\def\ion#1#2{\ensuremath{\mathrm{#1}\;}{\protect\small\rm\@Roman{#2}}}
\DeclareRobustCommand\nodata{$\cdots$}
\let\@small=\small
\let\@normalsize=\normalsize
\let\@footnotesize=\footnotesize
\let\@scriptsize=\scriptsize
\let\@tiny=\tiny
\let\@large=\large
\let\@Large=\Large
\let\@LARGE=\LARGE
\let\@huge=\huge
\let\@Huge=\Huge
\newcommand{\smaller}{\small}
\renewcommand{\normalsize}{\renewcommand{\smaller}{\small}\@normalsize}
\renewcommand{\small}{\renewcommand{\smaller}{\footnotesize}\@small}
\renewcommand{\footnotesize}{\renewcommand{\smaller}{\scriptsize}\@footnotesize}
\renewcommand{\scriptsize}{\renewcommand{\smaller}{\tiny}\@scriptsize}
\renewcommand{\tiny}{\renewcommand{\smaller}{\tiny}\@tiny}
\renewcommand{\large}{\renewcommand{\smaller}{\normalsize}\@large}
\renewcommand{\Large}{\renewcommand{\smaller}{\large}\@Large}
\renewcommand{\LARGE}{\renewcommand{\smaller}{\Large}\@LARGE}
\renewcommand{\huge}{\renewcommand{\smaller}{\LARGE}\@huge}
\renewcommand{\Huge}{\renewcommand{\smaller}{\huge}\@Huge}
%\newcommand\ion[2]{\text{#1\,\textsc{\lowercase{#2}}}}	% ionization states

%----------------------------------------------------------
% MNRAS SPECIAL SYMBOLS
%----------------------------------------------------------

%\newcommand\sq{\hbox{\rlap{$\sqcap$}$\sqcup$}}
\newcommand{\romn}[1] {{\mathrm #1}}

%INICIO de tablas clase rmaa.cls
\long\def\@caption#1[#2]#3{%
  \par
%%  \addcontentsline{\csname ext@#1\endcsname}{#1}%
%%    {\protect\numberline{\csname the#1\endcsname}{\ignorespaces #2}}%
\begingroup
    \@parboxrestore
    \if@minipage
      \@setminipage
    \fi
    \normalsize
    \@makecaption{\csname fnum@#1\endcsname}{\ignorespaces #3}\par
  \endgroup}

\renewcommand{\arraystretch}{1.15}
\setlength{\doublerulesep}{0.4pt}

\newcommand{\tablecols}[1]{\renewcommand{\@tablecols}{#1}}
\newcommand{\@tablecols}{1}
\newcommand{\tabcaptioncontinued}{%
  \multicolumn{\@tablecols}{c}{\addtocounter{table}{-1}TABLE~\thetable\ (CONTINUED)} \\ \\
  }

%\newcommand\tablenotemark[1]{$^\mathrm{#1}$}
\newcommand\tablenote[2]{\if@proceedings\else\small\fi ${}^\mathrm{#1}$ #2}
\newcommand\tablenoteskip{\\[0.5\baselineskip]}

\newcommand{\tabnotemark}[1]{\textsuperscript{\lowercase{#1}}}
\newcommand{\tabnotetextTWO}[4]{%
  \multicolumn{\@tablecols}{l}{%
    \parbox{0.5\tabnotewidth}{\small\textsuperscript{#1}#2}%
    \parbox{0.5\tabnotewidth}{\small\textsuperscript{#3}#4}%
    }%
  \\}
\newcommand{\tabnotetext}[2]{%
  \multicolumn{\@tablecols}{@{}p{\tabnotewidth}@{}}{\small\textsuperscript{#1}#2}\\}
\newlength{\tabnotewidth}
%FIN de tablas clase rmaa.cls

\newenvironment{appendices}{\par
  \begingroup
  \setcounter{section}{0}%
  \setcounter{subsection}{0}%
  \renewcommand\thesection{\@Alph\c@section}
  \renewcommand\theequation{\thesection\arabic{equation}}
  \medskip
  \section*{APPENDICES}}
{\endgroup}

\endinput