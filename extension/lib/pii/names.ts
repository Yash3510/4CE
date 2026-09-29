// Small gazetteer of common Indian given names and surnames, for names in free text
// ("Rohan Mehta" in a From column, "Hi Ananya"). A capitalised pair counts as a name only
// if one of its words is on these lists, which keeps UI words like "Travel Desk" out.

export const GIVEN = new Set(
  (
    'aarav aarti aakash aaliya aditi aditya afsana ahmed ajay akash akhil akshay alok amit amita amrita anand ananya anil anita anjali ankit ankita ' +
    'anup anupam anuradha anushka arjun arun aruna arvind asha ashok ashish ayesha bhavna bhavesh chetan chitra deepa deepak deepika dev devika dhruv ' +
    'dinesh divya farah farhan gaurav geeta girish gita gopal govind harish harsh hema hemant imran isha ishaan jaya jayant jyoti kabir kajal kamal ' +
    'kavita kavya kiran krishna kunal lakshmi lalit lata madhu mahesh manish manoj maya meena meera mohan mohit mukesh nandini naresh naveen neha nikhil ' +
    'nisha nitin pallavi pankaj pooja prakash pranav prashant pratik preeti priya priyanka rahul raj rajesh rakesh ram ramesh ravi rekha rekha reshma ' +
    'ritika rohan rohit sachin sadia sagar sahil sameer sana sandeep sanjay sanjana santosh sapna sarita shalini shreya shruti shweta siddharth simran ' +
    'sneha sonal sonia sumit sunil sunita suresh swati tanvi tarun uday usha varun vijay vikas vikram vinay vinod vishal vivek yash yogesh zara zoya ' +
    'fatima mohammed mohammad salman sneha tejas omkar aparna lavanya karthik venkat srinivas lakshman murali bala padma saravanan senthil vignesh ' +
    'harpreet gurpreet manpreet jaspreet navjot baljit sukhwinder parminder'
  ).split(' '),
);

export const SURNAMES = new Set(
  (
    'agarwal agrawal ahmed ahuja ali arora bajaj banerjee bansal basu bhat bhatia bhatt bose chakraborty chatterjee chaudhary chauhan chopra das ' +
    'dasgupta desai deshmukh deshpande dubey dutta gandhi ghosh gill goel gupta hegde iyer iyengar jain jha joshi kapoor kaur khan khanna kohli ' +
    'krishnan kulkarni kumar malhotra mehta menon mishra mukherjee murthy nair naidu pandey patel patil pillai prasad qureshi rao rathore reddy ' +
    'saxena sen sethi shah sharma shetty shukla singh sinha srinivasan subramanian thakur tiwari trivedi varma verma yadav chandra rajan natarajan ' +
    'ramachandran venkatesh pathak kamath shenoy pai bhardwaj tripathi dwivedi chaturvedi awasthi rastogi mathur kashyap dhillon sandhu grewal'
  ).split(' '),
);

const CAP = String.raw`[A-Z][a-z]{2,15}`;
/** Two or three capitalised words; filtered by the gazetteer in `nameCandidates`. */
// [ \t] not \s: a name never continues onto the next line ("Ananya Iyer\nAccount" is two things).
export const NAME_SEQ_RE = new RegExp(String.raw`\b${CAP}(?:[ \t]+${CAP}){1,2}\b`, 'g');
export const GREETING_RE = new RegExp(String.raw`\b(?:Hi|Hello|Hey|Dear|Namaste|Thanks|Regards|Shri|Smt|Mr|Mrs|Ms|Dr)\.?,?[ \t]+(${CAP}(?:[ \t]+${CAP})?)`, 'g');

export function isLikelyName(words: string[]): boolean {
  const lw = words.map((w) => w.toLowerCase());
  return GIVEN.has(lw[0]) || SURNAMES.has(lw[lw.length - 1]) || (lw.length === 3 && GIVEN.has(lw[1]));
}

const NOT_NAME_PARTS = new Set(['mail', 'info', 'admin', 'support', 'canary', 'noreply', 'no', 'reply', 'contact', 'test', 'hr', 'desk', 'office', 'team', 'hello', 'updates', 'alerts', 'service']);

/** "rohan.mehta.canary@mail.test" -> "Rohan Mehta": used to find that person's name elsewhere on the page. */
export function nameFromEmail(email: string): string | null {
  const parts = email.split('@')[0].split(/[._-]+/).filter((p) => /^[a-z]{3,}$/i.test(p) && !NOT_NAME_PARTS.has(p.toLowerCase()));
  if (parts.length < 2) return null;
  const words = parts.slice(0, 2).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
  return isLikelyName(words) ? words.join(' ') : null;
}
